# PCB-Viewer

A browser viewer for Altium Designer projects. It opens a project and shows its schematics, the PCB and
a 3D model of the board, with cross-probing between them: select a net or a part in one view and it is
highlighted in the others.

**Live:** https://shivam6279.github.io/PCB-Viewer/

## Features

- **Schematics** — every sheet of the hierarchy, multi-channel designs included; click a net, part or
  port to select it and follow it across sheets.
- **PCB** — all layers with a Layers/Objects panel (show, hide, single-layer view, top/bottom), net
  labels, and properties for pads, vias, tracks, parts and nets.
- **3D** — the layered board (copper, mask, silkscreen, plated holes) with the parts' STEP models.
- **GitHub history** — browse the projects in a GitHub repository and open any of them at any commit.
- **Compare commits** — pick two commits and view them side by side, with changed files marked in the
  project tree and changed schematic objects and PCB copper highlighted.
- **Local files** — open a project folder or a .zip from your computer; nothing is uploaded.

Everything runs in the browser; the site is a static page.

## Development

```bash
npm install
npm run dev          # http://localhost:5173
npm test             # unit tests
npm run build        # static site in dist/
npm run e2e          # browser tests (Playwright, Chrome)
```

The site reads the GitHub repository set in `src/github/config.ts`. On deploy
(`.github/workflows/pages.yml`) an index of that repository's commits and files is built with
`tools/build-index.mjs` and published with the site, so browsing makes no GitHub API requests; file
contents come from GitHub's raw-file CDN.

Altium files are parsed with [altiumts](https://github.com/tscircuit/altiumts) (MIT); the 3D view uses
[three.js](https://threejs.org) and [occt-import-js](https://github.com/kovacsv/occt-import-js).

## Disclaimer

PCB-Viewer is an independent project. It is not affiliated with, endorsed by or sponsored by Altium
Limited. Altium, Altium Designer and Altium 365 are trademarks of Altium Limited; they are used here only
to describe the file formats this viewer can open.

## License

[MIT](LICENSE)
