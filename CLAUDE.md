# PCB-Viewer

A static, client-side web app for Altium Designer projects: schematic, PCB and 3D views with
cross-probing, any commit of the owner's GitHub repo, and side-by-side commit diffs. Personal tool for
the owner; hosted on GitHub Pages, nothing uploaded. Not affiliated with Altium.

- **Git: commit only when the owner asks.** Branch `main`. Pages is taken down for now (both repos private,
  the deploy workflow disabled): the owner works locally; `git push` deploys nothing.
- Verify before handing back: run it end to end (unit + browser tests, screenshots) — the owner should
  never be the first to find it broken.

## Commands
Node is not on PATH in the shell tools: prefix `export PATH="/c/Program Files/nodejs:$PATH" &&`.

```bash
npm test                 # unit tests (vitest)
npm run test:corpus      # corpus tests against D:/Projects/PCB (ALTIUM_CORPUS env to override)
npx tsc --noEmit -p .    # typecheck (TS 7)
npm run build            # typecheck + vite build
npm run e2e              # Playwright, real Chrome (channel "chrome"); builds + serves on :4173 itself
npm run dev -- --port 5173 --strictPort   # dev server for the owner
npm run index            # the GitHub index from the local PCB clone, into public/index (gitignored)
```
- Corpus: `D:/Projects/PCB` (44 boards). Main test project: `Cubli/Main Board/STM32` (Cubli.PrjPcb).
- The owner's machine is their workstation: run only the affected specs, one worker, against the running
  dev server (`npx playwright test -c scratch/pw-dev.config.ts <spec>`; scratch/ is gitignored —
  recreate: spread `playwright.config`, `baseURL: "http://localhost:5173"`, `webServer: undefined`,
  `testDir: "../e2e"`, `workers: 1`). Never loop full suites.
- `SHOTS_DIR=scratch/shots` makes the e2e specs save screenshots — look at them.
- GitHub e2e (`e2e/github.spec.ts`) is offline: `e2e/github-fixture.ts` answers `api.github.com`, the raw
  CDN and the site index from the corpus repo with the git CLI. The live check (`e2e/github-live.spec.ts`)
  runs only with `GITHUB_TOKEN` set.
- Dev server gotchas: its file watcher sometimes misses edits and keeps serving the old module — `touch`
  the file (check with `curl localhost:5173/src/...`). A stale vite process can survive on `[::1]:5173`.
- Shell heredocs/sed eat backslashes (`\d`, `\r\n`, `"\\1SYM"`): write files with the Write/Edit tools
  or a node script file, and grep afterwards.

## Code map
- `src/github/` GitHub source: `config.ts` (OWNER, REPOS — the site reads only these; keep the deploy
  workflow's repo list in step), `client.ts` (fetch wrapper: ETags, paging, rate limits, ≤6 in flight,
  in-memory reuse when anonymous), `static-index.ts` (the index the deploy publishes: commits, branches,
  per-commit file lists — consulted before the API), `object-cache.ts` (IndexedDB by git sha, LRU 1 GB),
  `commit-source.ts` (`GitCommitSource`: one repo at one commit, rooted at the repo root; files from the
  raw CDN when anonymous), `discovery.ts`, `history.ts` (multi-folder commit merge), `route.ts` (hash
  URLs), `session.ts` (anonymous by default; optional pasted token), `project-tree.ts` (folders >
  projects; a folder holding just one project folds into it).
- `tools/build-index.mjs`: the index, from plain git on a blobless clone (no API). Run by
  `.github/workflows/pages.yml` on push, by hand, on a `pcb-push` repository_dispatch, and every 2 hours.
  With the deploy disabled nothing refreshes `public/index` but `npm run index` (after pulling the
  PCB clone). `GitHub.indexFreshness` + `src/app/IndexNotice.tsx`: on opening (and signing in) the
  app asks GitHub for the branch heads (the one API request with an index) and shows a notice when
  the index is behind, or when it can't check (private repo without a token).
- Screens: `src/app/Home.tsx` (start: top bar + search, project tree, drop zone or the selected
  project's `ProjectDetails.tsx` history; a viewer left for it is parked in `store.parked` and offered
  back), `CommitSwitcher.tsx` (commit pickers + Compare); URL ↔ screen in `src/app/github-open.ts`.
  "Not the latest" (`newer-commits.ts`: newer commits that changed the project, on the default branch):
  an amber button by the viewer's commit picker (opens the newest) and a "N newer" badge on GitHub recents.
- Compare: `?vs=<sha>` on a commit URL. `src/app/compare.ts` loads the second commit on its own parse
  worker into `store.compare`; `src/diff/diff.ts` (pure) finds changed files by blob sha and changed PCB
  objects / SCH record groups by fingerprint. Views read their project through `src/app/pane.ts`
  (`PaneContext`: data, diff flag, red/green mark, viewport `ViewLink`s), so `src/shell/DiffArea.tsx`
  shows two side by side (mode "Both") with one shared layers panel. Marks (`src/app/use-deltas.ts`, in
  Viewer) go on the commit SHOWN, against the other: Primary and Both mark A, Secondary marks B; green =
  only in it, red = only in the other (drawn where the other has it). Doc bar (`DeltaBar.tsx`, always
  there while comparing): status / "N changes" list, No deltas / Deltas / Deltas only (`store.deltas`).
  Part outlines follow the layer view by side. PCB compares ARTWORK, not objects (`src/diff/artwork.ts`, on `artwork.worker.ts`;
  Clipper side `artworkDifference` in `board-geometry.ts`): per layer the merged copper minus drills,
  mask openings, silk/paste/mech, drills, board shape; regions under 1 mil mean width dropped. A part
  moved/added/removed (matched by source id) is its outline, its own objects left out. Copper layers are
  paired by NAME (a restack renumbers keys; same key + other name = another layer unless most objects
  match); a layer in one board only is one change. Pieces gathered within 25 mil into areas no larger
  than 300 mil (`ARTWORK_CELL`; big pieces split by grid cell); "N changes" lists them, zooms both.
  Changed objects only say where to look; re-poured pours only where the poured copper differs.
  Blocks moved together (`src/diff/moves.ts`, pure): items in one commit only, keyed by shape relative to
  their own position, vote for their offset; the biggest offset first, split by place, >= 3 items (>= 8 with
  no part: via grids line up by chance). PCB: matched LAYER BY LAYER (a block is on one layer, shown only
  with it): loose objects + shifted parts (same turn/side, on their side copper layer); vias on Multi-Layer.
  Drawn as one box here, dashed box there, arrow. SCH: record markup made position-relative by `sch-moves.ts`.
- `src/source/` project sources (folder, dropped entries, zip). `src/model/` hierarchy, project load,
  per-sheet connectivity, project net compile (`compile.ts`). `src/parse/` altiumts wrappers, the parse
  worker (`parse.worker.ts` via Comlink) and `project-data.ts` (sheets + compile + board, built once).
- `src/sch/` schematic view: vendored altiumts SVG renderer (`render/`, MIT, heavily extended),
  click/hover (`interaction.ts`, `sheet-scene.ts`), popups (`PortMenu.tsx`: `SchPopup` + the sheets a
  net reaches, on a click on a net/port/entry; `PartCard.tsx`: right-click on a part), per-instance
  texts and net colours written into the SVG (`sheet-text.ts`, shared with the PDF). Net labels are
  moved last in `prepare-svg.ts` (drawn over wires/buses). `pdf/`: Export PDF (doc bar, SCH tab;
  `SchPdfDialog.tsx` settings in `options.ts`: net colours (remembered), physical ("pages", always the
  default) or logical ("grouped"); jsPDF + svg2pdf, lazy): physical = one page per sheet instance in
  hierarchy order; logical = one page per schematic DOCUMENT (placed by REPEAT or by several sheet
  symbols alike): designators and net labels written as what the instances share + an orange italic *
  (`writeWildcardNames`, `wildcard` in `channel-note.ts`: R1_CAN0/1/2 -> R1_CAN*), under a band saying
  what * is per instance; links and parts/nets of a shared page go to its first instance's. Text in
  styled pieces is laid out piece by piece (`layOutPieces`); reset jsPDF's font before svg2pdf (it
  inherits whatever font measuring left, e.g. italic). The sheets' own fonts embedded
  from this computer (`local-fonts.ts`, `queryLocalFonts` asked straight from the click), else standard
  PDF fonts (`svg-for-pdf.ts`: baselines, overlines, CP1252); links port↔entry↔symbol (`links.ts`,
  corpus-checked). A click on a part / wire run / label / power port runs PDF JavaScript
  (`click-menus.ts`; link order: parts, nets, then ports on top): app.popUpMenu of the part's details
  (`part-facts.ts`, shared with the card) or of the sheets a net is on, each a named /FitR destination
  (catalog /Dests) zoomed to the net. Acrobat and Reader only; Chrome's viewer ignores JavaScript link
  actions (tested: also Altium's own PDFs). jsPDF writes no JavaScript links: placeholder URI links are
  rewritten in the finished file at equal length. No parts/nets list pages (the owner did not want them). Blankets (record 225, in the
  Additional stream like harnesses) are drawn by `render-harness.ts`. Title-block expressions (=Copy(DocumentName, 1, ...), 'Sheet ' + SheetNumber) are
  evaluated in `render/special-string-expression.ts`; the app supplies =VariantName and the commit.
- `src/pcb/` PCB view: `scene.ts` (board → shapes per layer, worker side), `layers.ts` (layer
  names/colours/order), `draw.ts` (Canvas2D renderer), `labels.ts` (net labels), `hit.ts`,
  `selection.ts` (selection ↔ board objects), `nets.ts` (routed length, layers used), `PcbView.tsx`,
  `LayersPanel.tsx` (flip, layer mode, object types), `LayerLegend.tsx` (layers on the board:
  eye, current layer, mode/side chips), `layer-state.ts` (LayerState: visible, current, mode all/highlight/only,
  flip; pure + tested), `stackup.ts` (the V9 stack records -> layer table; `PcbData.stackup`) + `StackupDialog.tsx`
  (doc-bar Stackup: cross-section bands + layer table, a modal portalled to body), `stroke-font.ts` (generated by `tools/gen-stroke-font.mjs`).
- `src/3d/` 3D view (three.js, lazy-loaded). Data side, in its own worker (`board.worker.ts`, one per side
  of a comparison, never the parse worker): `board3d.ts` (stack with depths, the board's saved 3D colours,
  component bodies + placement), `board-geometry.ts` (the layered board: copper per layer and object type
  with drills cut out, dielectric bands, masks with openings, silk, plated barrels — clipper-lib + earcut;
  big many-hole faces are triangulated in tiles), STEP files. `prefetch.ts` loads it all (plus STEP
  meshes: `step.worker.ts` pool, IndexedDB cache by hash, `step-styles.ts` colours) in the background
  when a project opens. View side: `board-layers.ts`, `materials.ts` (the selection dimmer),
  `components.ts`, `engine.ts` (camera, lights, mouse, picking), `orbit.ts` (pivot maths), `View3d.tsx`,
  `ObjectsPanel.tsx`.
- Views stay mounted once opened and are switched by OPACITY on their own compositor layers (`.view-pane`),
  never display:none: a display:none pane came back at 0x0 and resized + redrew its whole canvas/SVG at
  device resolution on every switch. PCB and 3D are built ahead, hidden, in idle time; hidden views defer
  redraws to idle (`src/app/idle.ts`). Popups portal to `document.body` (a pane is a stacking context).
- `src/bom/` BOM tab: `bom.ts` (pure) groups parts into lines: parts from the board (compiled designators,
  schematic parameters joined by source path), else the compiled schematics; a `.BomDoc` has no designators,
  only catalog items keyed `<library>[/<table>]\<item>` with part choices, matched to parts by that key
  (`libraryItem`). Built in the parse worker (`ProjectData.bom`); `BomView.tsx` is the table.
- `src/shell/` top bar, tree (M/A/D badges when comparing), doc bar (mode bar), Inspector, ViewArea.
- `src/app/store.ts` zustand: screen, parked viewer, compare, project data, `selection`, focus/jump.

## Must-know facts (each cost real debugging)
- Net names / connectivity: see the `compile.ts` header. Verified exact on Cubli: every PCB net's pads ↔
  one compiled net, all 286 names. Components link to the board by their source path
  (`\1OCQKBGNW\SRADDCIC\BHDUXFNR`, channel index prefixed for REPEAT). **Show physical designators everywhere** (R5_ESC_2,
  TVS1_CAN0); the logical one (R5_ESC, TVS1) only as an aside in the inspector. A PCB part record holds
  only the logical SOURCEDESIGNATOR (repeats across channels); the physical one is the text of its
  designator string (`physicalDesignators` in extract-pcb.ts). With a board, compile takes those by
  source path (the channel format misses sheets placed by several sheet symbols, and boards annotated on
  their own); the schematic view writes each instance's onto its designator texts.
- PCB layer colours are not in the file: the default scheme keyed by the layer's V7 identity (GND 1 is
  Mid-Layer 3 → green). Stack order from the V9 stack. See `layers.ts`.
- Custom-shaped pads: the pad record is a 1 mil placeholder; the copper is a region whose PADINDEX is the
  pad's position in the pad list counted from 1 (checked by net on every corpus board). `scene.ts` makes
  that region the pad's shape (owned by the part), not loose copper.
- Footprint pictures (inspector, `pcb/footprint-svg.ts`) are per FOOTPRINT, not per placement: drawn once
  from one placement (0° on top if any), turned back and un-mirrored, every layer as its top-side
  counterpart, courtyard/origin greyed. The frame is computed from the turned geometry: an SVG `getBBox`
  of a transformed group is the box of the turned box and made every rotation frame differently.
- PCB rendering: every layer ~85% opaque so layers blend; polygon pours ~25%; vias/through-hole pads are
  copper on every layer they span, silver Multi-Layer on top in the full view; via holes translucent
  brown, pad holes teal; selection = whole board greyscale except the selection.
- Net labels: one size for every label in a view, from the zoom only; drawn live every frame (not into
  the cached bitmap); pads → vias → tracks, never overlapping.
- PCB smoothness: pan/zoom shift a cached bitmap (margin ½ view per side, half-res draft mid-pan, full
  redraw on settle); layer paths are chunked in a 12×12 grid so redraws fill only what is in view.
- Schematic net colours come from the compiled net (`ProjectData.wireColors`), so a colour on 12V also
  colours it where lower sheets call it V_GATE_DRIVE.
- PCB interaction: hover/selection box = extent of the whole footprint except text, 2 px; only objects
  shown in the current layer view can be hovered/picked; click inside a part picks the part, even on its pads:
  a part's pads are picked only once it (or a pad of it) is selected (`openPart`; 3D picks pads first); double-click
  selects the net under the cursor, looking past parts; right-click lists everything there; with
  something selected there is no hover box (a selected pad's part stays outlined) and a click outside the
  selection only clears it (`hitInSelection`); Shift-hover outlines (white, fixed screen width) the copper of the current layer's net under the cursor
  (live view, per layer the merged shape stroked then cut out; eased per net: `drawNetGlow`), starting only when the mouse moves onto
  a net after Shift is pressed (`shiftHover`); the camera + layer state survive tab switches (`savedViews` in PcbView).
- 3D: colours from the board's `3DCONFIGURATION`; the bare board is the core (FR4) colour under the
  translucent mask; even lighting fixed to the board, no specular. STEP placement: top
  `T(x,y,dz)·Rz·Ry·Rx`, bottom `T(x,y,-T-dz)·Rx(180°)·Rz·Ry·Rx` (corpus test checks all 441 Cubli bodies).
  occt-import-js returns colours LINEAR and misses/misorders some styles: solid colours come from
  `step-styles.ts`, mapped by solid + face order. Camera state is relative to the board's geometric
  centre (orientation + distance + a screen-plane offset; never a world-space target). Turns pivot on the
  middle of the screen at the board's mid-plane (`orbit.ts`). Ray tests through three-mesh-bvh trees
  built in the 3D worker (keep ALL serialised fields). A net/object highlight is a second render pass over
  a cleared depth buffer. Bump `CACHE_VERSION` in `step-mesh.ts` whenever mesh/colour output changes.
- Keys: 1-4 switch SCH/PCB/3D/BOM (Viewer, `tabEnabled`); on PCB, Shift+S layer mode, Ctrl+Shift+wheel and
  +/- step the current layer through the visible ones, F mirrors, Esc clears the selection,
  Shift+Tab steps the selection through everything under the last click (`hitsAt`; right-click lists it);
  on 3D, F turns the board over (top <-> bottom): half a turn about the screen's vertical laid flat on the board,
  through the board centre (from the side: the line of sight laid flat), eased (`flip`).
- 3D view cube (`ViewCube.tsx`, top right, see-through, faces depth-sorted with preserve-3d): CSS 3D faces set from
  the camera after every frame (`onRender`); a face click eases the view straight to that side about the
  mouse-turn pivot (`showFace`, faces in `CUBE_FACES`); a drag on it turns the board; hover arrows turn about one
  view axis (`stepTurn` a quarter turn on click, `turnAbout` on drag).
- Browser tab title: `PCBV-<project name>` while a project is open, else `PCBV` (App.tsx).
- Test hooks: `.pcb-canvas.__pcb` = `{ scene, toClient(x,y), camera(), layers(), view(cx,cy,scale), timing(), hover(), padPart(), glow(), pick(x,y), hits(x,y) }`;
  SVG schematic records carry `data-i` (record index), `data-k` (kind), `data-o` (owner).
  `.view3d-canvas.__view3d` = the BoardEngine (`toClient`, `stats()`, `rotationPivot()`, `fitView`, `setView`, `pick`).
