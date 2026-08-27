import { Config } from "@remotion/cli/config";

// Content Studio bundle root. Local @remotion/renderer runs here for dev/CI
// (ADR-7) — product renders go through Remotion Lambda; this config is what
// `npx remotion render` / `npx remotion studio` use locally, and tests never
// need AWS.
Config.setVideoImageFormat("jpeg");
Config.setConcurrency(4);

// Source uses NodeNext ".js" specifiers that resolve to ".tsx"/".ts" files
// (matches the ported founder-journey setup this package is derived from —
// see ARCHITECTURE.md §1.1 reel.ts/Root.tsx). Webpack must try the TS
// extensions first or it can't resolve them.
Config.overrideWebpackConfig((c) => ({
  ...c,
  resolve: {
    ...c.resolve,
    extensionAlias: {
      ...(c.resolve?.extensionAlias ?? {}),
      ".js": [".tsx", ".ts", ".js"],
    },
  },
}));

export {};
