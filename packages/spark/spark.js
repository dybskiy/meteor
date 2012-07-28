// XXX figure out good liverange tag names. should they be symbolic constants?
// in liverange-land they should probably start with "_"?

Spark = {};

Spark._currentRenderer = new Meteor.EnvironmentVariable;

Spark._Renderer = function () {
  // Map from annotation ID to an annotation function, which is called
  // at render time and receives (startNode, endNode.)
  this.annotations = {};
};

_.extend(Spark._Renderer.prototype, {
  createId: function () {
    var id = "";
    var chars =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    for (var i = 0; i < 8; i++) {
      id += chars.substr(Math.floor(Meteor.random() * 64), 1);
    }
    return id;
  },

  // what can be a function that takes a LiveRange, or just a set of
  // attributes to add to the liverange.  tag and what are optional.
  // if no tag is passed, no liverange will be created.
  annotate: function (html, tag, what) {
    var id = tag + "-" + this.createId();
    this.annotations[id] = function (start, end) {
      if (! tag)
        return;
      var range = new LiveRange(tag, start, end);
      if (what instanceof Function)
        what(range);
      else
        _.extend(range, what);
    };

    return "<$" + id + ">" + html + "</$" + id + ">";
  }
});

////////// PUBLIC API

Spark.render = function (htmlFunc) {
  var renderer = new Spark._Renderer;
  var html = Spark._currentRenderer.withValue(renderer, function () {
    return renderer.annotate(htmlFunc());
  });

  var fragById = {};

  var replaceInclusions = function (container) {
    var n = container.firstChild;
    while (n) {
      var next = n.nextSibling;
      if (n.nodeType === 8) { // COMMENT
        var frag = fragById[n.nodeValue];
        if (frag === false) {
          // id already used!
          throw new Error("Spark HTML fragments may only be used once. " +
                          "Second use in " +
                          DomUtils.fragmentToHtml(container));
        } else if (frag) {
          fragById[n.nodeValue] = false; // mark as used
          DomUtils.wrapFragmentForContainer(frag, n.parentNode);
          n.parentNode.replaceChild(frag, n);
        }
      } else if (n.nodeType === 1) { // ELEMENT
        replaceInclusions(n);
      }
      n = next;
    }
  };

  var bufferStack = [[]];
  var idStack = [];

  var regex = /<(\/?)\$([^<>]+)>|<|[^<]+/g;
  regex.lastIndex = 0;
  var parts;
  while ((parts = regex.exec(html))) {
    var isOpen = ! parts[1];
    var id = parts[2];
    var annotationFunc = renderer.annotations[id];
    if (! annotationFunc) {
      bufferStack[bufferStack.length - 1].push(parts[0]);
    } else if (isOpen) {
      idStack.push(id);
      bufferStack.push([]);
    } else {
      var idOnStack = idStack.pop();
      if (idOnStack !== id)
        throw new Error("Range mismatch: " + idOnStack + " / " + id);
      var frag = DomUtils.htmlToFragment(bufferStack.pop().join(''));
      replaceInclusions(frag);
      // empty frag becomes HTML comment <!--empty--> so we have start/end
      // nodes to pass to the annotation function
      if (! frag.firstChild)
        frag.appendChild(document.createComment("empty"));
      annotationFunc(frag.firstChild, frag.lastChild);
      if (! idStack.length)
        // we're done; we just rendered the contents of the top-level
        // annotation that we wrapped around htmlFunc ourselves.
        // there may be unused fragments in fragById that include
        // LiveRanges, but only if the user broke the rules by including
        // an annotation somewhere besides element level, like inside
        // an attribute (which is not allowed).
        return frag;
      fragById[id] = frag;
      bufferStack[bufferStack.length - 1].push('<!--' + id + '-->');
    }
  }
};

Spark.setDataContext = function (html, dataContext) {
  var renderer = Spark._currentRenderer.get();
  if (!renderer)
    return html;

  return renderer.annotate(html, "_data", { data: dataContext });
};

Spark.getDataContext = function (node) {
  var range = LiveRange.findRange("_data", node);
  return range && range.data;
}

Spark.isolate = function (htmlFunc) {
  var renderer = Spark._currentRenderer.get();
  if (!renderer)
    return htmlFunc();

  var ctx = new Meteor.deps.Context;
  var slain = false;
  var html =
    renderer.annotate(ctx.run(htmlFunc), "_isolate", function (range) {
      range.finalize = function () {
        // "Fast" GC path -- someone called finalize on a document
        // fragment that includes us, so we're cleaning up our
        // invalidation context and going away.
        slain = true;
        ctx.invalidate();
      };

      ctx.on_invalidate(function () {
        if (slain)
          return; // killed by finalize. range has already been destroyed.

        if (!DomUtils.isInDocument(range.firstNode())) {
          // "Slow" GC path -- Evidently the user took some DOM nodes
          // offscreen without telling us. Finalize them.
          var node = range.firstNode();
          while (node.parentNode)
            node = node.parentNode;
          if (node["_protect"]) {
            // test code can use this property to mark a root-level node
            // (such as a DocumentFragment) as immune from slow-path GC
          } else {
            Spark.finalize(node);
            return;
          }
        }

        // htmlFunc changed its mind about what it returns. Rerender it.
        var frag = Spark.render(function () {
          return Spark.isolate(htmlFunc);
        });
        var oldContents = range.replace_contents(frag); // XXX should patch
        Spark.finalize(oldContents);
        range.destroy();
      });
    });

  return html;
};


// Delete all of the liveranges in the range of nodes between `start`
// and `end`, and call their 'finalize' function if any. Or instead of
// `start` and `end` you may pass a fragment in `start`.
Spark.finalize = function (start, end) {
  _.each(["_data", "_isolate"], function (tag) {
    var wrapper = new LiveRange(tag, start, end);
    wrapper.visit(function (isStart, range) {
      isStart && range.finalize && range.finalize();
    });
    wrapper.destroy(true /* recursive */);
  });
};