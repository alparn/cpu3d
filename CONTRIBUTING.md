# Contributing to cpu3d

Thanks for your interest! cpu3d is small on purpose, so contributions that keep it lean are the easiest to merge.

## Ground rules

- **Zero runtime dependencies.** Node built-ins and browser APIs only.
- **No build step.** Plain ES modules that run in the browser and in Node as they are.
- **Tools first.** New editor features should be tools in `src/tools.js` that the UI calls, so agents get them too.
- **Recipes are data.** Never evaluate code from recipes or agent input.
- Match the surrounding style: small functions, typed arrays in hot paths, comments that explain *why*.

## Development

```bash
git clone https://github.com/alparn/cpu3d.git
cd cpu3d
npm start            # editor on http://localhost:8173
npm test             # node:test suite
npm run bench        # renderer benchmark
npm run examples     # rebuild the gallery scenes and thumbnails
```

Node 18 or newer. There is nothing to install.

## Pull requests

1. Open an issue first for bigger changes, so we can agree on the approach.
2. Add or update tests in `test/` (rasterizer changes must keep the brute-force coverage test green).
3. If you touch the renderer, include `npm run bench` numbers before and after.
4. Keep commits focused and describe the *why* in the message.

## Good first issues

- New recipe types (for example `revolve` with partial angles, `loft` between two shapes)
- More gallery scenes in `examples/build.mjs`
- Keyboard shortcuts and small editor polish
- Docs: recipes for common objects, agent prompting tips
