# SSR Options

## ssr.external

- **Type:** `string[]`
- **Related:** [SSR Externals](/guide/ssr#ssr-externals)

Force externalize dependencies for SSR.

## ssr.noExternal

- **Type:** `string | RegExp | (string | RegExp)[] | true`
- **Related:** [SSR Externals](/guide/ssr#ssr-externals)

Prevent listed dependencies from being externalized for SSR. If `true`, no dependencies are externalized.

## ssr.target

- **Type:** `'node' | 'webworker'`
- **Default:** `node`

Build target for the SSR server.

## ssr.format

- **Experimental:** [CJS support to be removed in Vite 5](https://github.com/vitejs/vite/discussions/13816)
- **Deprecated** Only ESM output will be supported in Vite 5.
- **Type:** `'esm' | 'cjs'`
- **Default:** `esm`

Build format for the SSR server. Since Vite v3 the SSR build generates ESM by default. `'cjs'` can be selected to generate a CJS build, but it isn't recommended. The option is left marked as experimental to give users more time to update to ESM. CJS builds require complex externalization heuristics that aren't present in the ESM format.

## ssr.resolve.conditions

- **Type:** `string[]`
- **Related:** [Resolve Conditions](./shared-options.md#resolve-conditions)

Defaults to the the root [`resolve.conditions`](./shared-options.md#resolve-conditions).

These conditions are used in the plugin pipeline, and only affect non-externalized dependencies during the SSR build. Use `ssr.resolve.externalConditions` to affect externalized imports.

## ssr.resolve.externalConditions

- **Type:** `string[]`
- **Default:** `[]`

Conditions that are used during ssr import (including `ssrLoadModule`) of externalized dependencies.
