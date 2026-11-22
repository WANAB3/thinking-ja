window.__ModuleLoader__.load({
	id: "thinking-ja",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/harness/dsh/client.tsx
var client_exports = {};
__export(client_exports, {
  apply: () => apply,
  inject: () => inject,
  name: () => name
});
module.exports = __toCommonJS(client_exports);
var import_react = require("react");
var import_jsx_runtime = require("react/jsx-runtime");
var TRANSLATE_PATH = "/_thinking-ja/translate";
function ThinkingJaBody({ text, rawText, running, renderFactorySlot }) {
  const [ja, setJa] = (0, import_react.useState)();
  (0, import_react.useEffect)(() => {
    setJa(void 0);
    if (running || !rawText.trim()) return;
    const abort = new AbortController();
    fetch(TRANSLATE_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: rawText }),
      signal: abort.signal
    }).then((response) => response.ok ? response.json() : void 0).then((body) => {
      const translated = body && typeof body === "object" && "ja" in body ? body.ja : void 0;
      if (!abort.signal.aborted && typeof translated === "string") setJa(translated);
    }).catch(() => {
    });
    return () => abort.abort();
  }, [rawText, running]);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
    renderFactorySlot("conversation.chat.reasoning.content", { text, running }),
    ja === void 0 ? null : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { "data-thinking-ja": "", style: { marginTop: 8, paddingTop: 8, borderTop: "1px dashed currentColor", opacity: 0.8 }, children: renderFactorySlot("conversation.chat.reasoning.content", { text: ja, running: false }) })
  ] });
}
var name = "thinking-ja";
var inject = ["slots"];
function apply(ctx) {
  ctx.slots.inject(
    "conversation.chat.reasoning.body",
    () => ctx.slots.register({ name: "conversation.chat.reasoning.body", priority: 50 }, ThinkingJaBody)
  );
}

		return module.exports;
	}
});

