/*
 * cad-viewer-host.js — helper for pages that embed the viewer in an <iframe>.
 * Plain script, no build step, no dependencies. Works as <script src> or as an ES module import.
 *
 *   <iframe id="v" src="https://viewer.example.com/embed.html?ui=compact"></iframe>
 *   <script src="https://viewer.example.com/sdk/cad-viewer-host.js"></script>
 *   <script>
 *     const viewer = new CadViewerFrame(document.getElementById('v'))
 *     await viewer.ready
 *     await viewer.setHeaders({ Authorization: 'Bearer ' + token })    // optional, never put tokens in the URL
 *     await viewer.openFromSource('plm', 'PRT-1001')
 *     viewer.on('select', ({ part }) => console.log(part && part.name))
 *     await viewer.colorize({ 'Engine_*': '#f39c12' })
 *   </script>
 */
(function (global) {
  var CHANNEL = 'cad-viewer';
  var METHODS = [
    'load', 'openFromSource', 'clear', 'cancel', 'fit', 'setView', 'setProjection', 'setUpAxis', 'setDisplayMode',
    'setSection', 'setExplode', 'setGrid', 'setFlyMode', 'setQuality', 'getTree', 'getParts', 'find', 'select',
    'getSelection', 'zoomTo', 'show', 'hide', 'isolate', 'showAll', 'colorize', 'resetColors', 'setTool',
    'getMeasurements', 'clearMeasurements', 'getStats', 'screenshot', 'listSources', 'listModels', 'setHeaders',
  ];

  function CadViewerFrame(iframe, options) {
    options = options || {};
    var self = this;
    this.iframe = iframe;
    this.origin = options.origin || new URL(iframe.src, location.href).origin;
    this.timeout = options.timeout || 120000;
    this._id = 0;
    this._pending = {};
    this._handlers = {};
    this.ready = new Promise(function (resolve) { self._resolveReady = resolve; });

    this._onMessage = function (ev) {
      var msg = ev.data;
      if (ev.source !== iframe.contentWindow || ev.origin !== self.origin || !msg || msg.channel !== CHANNEL) return;
      if (msg.event === 'ready') return self._hello();
      if (msg.event) return self._emit(msg.event, msg.data);
      var p = self._pending[msg.id];
      if (!p) return;
      delete self._pending[msg.id];
      clearTimeout(p.timer);
      if ('error' in msg) p.reject(new Error(msg.error)); else p.resolve(msg.result);
    };
    global.addEventListener('message', this._onMessage);
    // The iframe may have loaded before this helper was created: say hello now and on every (re)load.
    iframe.addEventListener('load', function () { self._hello(); });
    this._hello();
  }

  /** Handshake: after 'hello' the viewer sends events only to this page's origin. */
  CadViewerFrame.prototype._hello = function () {
    var self = this;
    if (!this.iframe.contentWindow) return;
    try {
      // Still on about:blank (same-origin, readable): wait for the viewer page's 'ready' / load event.
      if (this.iframe.contentWindow.location.href === 'about:blank') return;
    } catch (e) { /* cross-origin page loaded: go ahead */ }
    var id = ++this._id;
    var timer = setTimeout(function () { delete self._pending[id]; }, 5000);
    this._pending[id] = {
      resolve: function (info) { self.info = info; self._resolveReady(self); },
      reject: function () {},
      timer: timer,
    };
    try {
      this.iframe.contentWindow.postMessage({ channel: CHANNEL, id: id, method: 'hello', args: [] }, this.origin);
    } catch (e) { /* iframe still on about:blank */ }
  };

  CadViewerFrame.prototype._send = function (method, args) {
    var self = this, id = ++this._id;
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        delete self._pending[id];
        reject(new Error('cad-viewer: "' + method + '" timed out'));
      }, self.timeout);
      self._pending[id] = { resolve: resolve, reject: reject, timer: timer };
      self.iframe.contentWindow.postMessage({ channel: CHANNEL, id: id, method: method, args: args }, self.origin);
    });
  };

  /** Calls any viewer API method: frame.call('isolate', ['Wheel_*']) */
  CadViewerFrame.prototype.call = function (method) {
    var args = Array.prototype.slice.call(arguments, 1);
    var self = this;
    return this.ready.then(function () { return self._send(method, args); });
  };

  METHODS.forEach(function (m) {
    CadViewerFrame.prototype[m] = function () {
      return this.call.apply(this, [m].concat(Array.prototype.slice.call(arguments)));
    };
  });

  /** Events: load, loadstart, progress, error, select, visibility, measure, clear. Returns an unsubscribe function. */
  CadViewerFrame.prototype.on = function (event, fn) {
    var list = this._handlers[event] = this._handlers[event] || [];
    list.push(fn);
    return function () { list.splice(list.indexOf(fn), 1); };
  };
  CadViewerFrame.prototype._emit = function (event, data) {
    (this._handlers[event] || []).forEach(function (fn) { try { fn(data); } catch (e) { console.error(e); } });
  };
  CadViewerFrame.prototype.destroy = function () {
    global.removeEventListener('message', this._onMessage);
  };

  global.CadViewerFrame = CadViewerFrame;
})(typeof window !== 'undefined' ? window : this);
