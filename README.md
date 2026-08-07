# Gridlock City

> Untangle impossibly packed parking lots one perfect slide at a time, and watch a gridlocked city come back to life — district by district, horn by horn.

A playable implementation of the *Gridlock City* design document: a traffic-unblock puzzle with a City Rebuild meta, built as a portrait-first web game in TypeScript with no runtime dependencies.

```
npm install
npm run dev        # play it at http://127.0.0.1:5173
npm run verify     # typecheck + unit tests + production build
npm run smoke      # drive the real game in Chromium and screenshot it
```

## The game in one paragraph

Every lot is an integer grid. Every vehicle is an axis-aligned segment with a facing, and it moves only along that facing — forward or back. Reach a curb cut and it commits and drives off. Blocked, it honks, wobbles, and flashes the car that said no; the bump costs nothing. The puzzle is never *can I move this car*, it is *can I read the order*. Clear the lot and the district earns a little more of itself back.

## How it is put together

Three layers, strictly separated — the same split the design document specifies, and the reason the whole thing is testable.

| Layer | Path | What it owns |
|---|---|---|
| Deterministic sim | `src/core` | The lot as integers. No DOM, no clock, no randomness that is not seeded. |
| Presentation | `src/view`, `src/audio`, `src/game` | Canvas rendering, input, animation, procedural sound. All of it skippable. |
| Meta & services | `src/meta`, `src/ui` | Economy, save, districts, garage, screens. |

The sim is the interesting constraint: because `sim.ts` is a pure function of `(state, request)`, the identical code runs in the client, in the solver, in the level generator, and in the tests. Validation is free.

### `src/core` — the sim, the solver, the forge

**`sim.ts`** resolves every move. A drag becomes a `Move` or a bump; oil slicks carry a car past where it was aimed; one-way arrows refuse travel against them; the Velvet Rope holds ordinary cars while a VIP is still on the lot; a roundabout plate lets a nosed car pivot ninety degrees.

**`solver.ts`** answers "can this still be cleared" two ways:

1. **Exit-only search.** If no car ever needs repositioning, occupancy is a pure function of *who is left*, so the search memoises on a bitmask and finishes in microseconds. When it succeeds the answer is provably optimal — clearing *n* cars needs at least *n* slides, and this clears them in exactly *n*.
2. **Bounded best-first search** over full slide and pivot moves, for the lots that genuinely need a car pulled out of the way.

It also measures difficulty. Knot depth is the longest chain in the *precedence DAG*: a car only leaves along its facing, so every car standing on that ray must go first — an absolute ordering, independent of which valid solution the player picks.

**`generator.ts` (JamForge)** builds lots **backwards**. Vehicles are inserted one at a time, and an insertion is only accepted if that car could drive straight off the lot given everything already placed. Replaying the insertions in reverse is therefore always a valid solution, which makes every generated jam solvable by construction — the promise the design document makes to the player, kept structurally rather than by testing after the fact.

Knot depth is *authored*, not hoped for. Each candidate placement is scored by the chain depth it would actually create, computed from a per-car "how deep is the knot above this car" pass. Chasing a single chain tail stalls at three or four links, because each link starts closer to the street than the one it blocks; scoring every placement by its real contribution does not.

**`campaign.ts`** describes 320 launch jams rather than storing them. A global level index determines band, pattern, grid size, car count, knot depth, distractor ratio, street frontage and modifier load; JamForge turns that into the same lot on every device, every time. The whole sequence costs zero bundle bytes and every number in it is a tunable.

### A finding worth writing down

The obvious lever for difficulty — narrowing the street frontage — turned out to do the opposite of what it looks like. A car only ever leaves straight along its facing, so a curb cut on a given lane is what makes that lane usable at all. Open one edge and every car must face the same way: the lot is a shallow queue that holds few cars and knots barely three deep. Open four and lanes cross, dependency chains can turn corners, and the same grid packs denser *and* knots deeper.

Measured across 120 generated lots on a 7×10 grid:

| Street sides × width | Median cars | Median knot depth | Max depth |
|---|---|---|---|
| 2 × 0.45 | 12 | 4 | 7 |
| 3 × 0.60 | 16 | 5 | 8 |
| 4 × 0.90 | 16 | 7 | 10 |

So difficulty lives in density, distractors and vocabulary, and frontage width became a *simplicity* lever — reserved for the opening levels and for the deliberately constrained Plug pattern.

### `src/view` — the lot you can touch

A 2D toy diorama. The ground is a foreshortened grid baked to an offscreen canvas and blitted, so a frame costs one image draw plus the vehicles. Each vehicle is a chunky bevelled brick: a dark base plate, three lit side faces, an inset top, wheels at the axle line and a rim that keeps bumper-to-bumper cars of the same colour distinct.

Extrusion height is deliberately low. A lifted top face is drawn *above* its own cells, so a tall car covers the one parked behind it — enough height to read as a solid object, not so much that it hides a neighbour and breaks the count.

Slides use an anticipation ease: a short pull-back, an eased run, a two-bounce suspension settle, and a body that leans against its own acceleration. Exits accelerate away. The last car gets four tenths of a second of slow motion and a camera pull-back.

### `src/audio` — no sample bytes

Everything is synthesised at runtime. Three buses with independent toggles, per-class horn voices, tyre roll whose pitch and grain follow drag velocity, and an exit melody keyed to the district — a chained solve literally performs the tune, and the last car resolves it. Every piece of gameplay information lives on the SFX bus, so a music-off player loses nothing.

### `src/meta` — the city

Districts, seven projects each with costs that escalate by district index, City Income capped at four hours, Mystery Trunks with published odds, streaks that pause rather than reset, the Garage, the Dispatch Board, the City Pass. Saves are versioned and defensively migrated: an older save is folded onto a fresh one so nothing is ever missing, and a hand-edited one is repaired without taking value away.

## Design commitments that are enforced in code, not just intended

- **Every jam is solvable unaided.** Guaranteed by construction in the generator, and re-verified for all 320 levels on every test run.
- **A mistake costs nothing.** Bumps are free and diagnostic. One-way arrows and oil slicks make some slides irreversible, so there is an unlimited **Undo**, and when a lot really has been knotted for good the game notices and says so rather than letting the player grind at it.
- **Never more than one modal deep.** The win screen does not stack an offer on top of itself; the pinch offer and the interstitial are mutually exclusive, and the smoke test fails the build if two overlays are ever open at once.
- **Interstitials, exactly as specified.** Never before level 12, only on the way out of a win screen, ninety-second cooldown that lengthens after the sixth impression of a session, hard cap of twelve, and any purchase buys a twenty-four-hour holiday. There is no ad network here — the placements are honest simulations, so the guardrails around them are real and testable.
- **Nothing owned is ever removed.** Keys and tickets above their cap convert to Coins instead of evaporating. A broken streak pauses at its last milestone.
- **Odds are published in-game**, in the settings sheet, because they should be.

## Accessibility

Vehicle identity is never colour-only: class silhouettes differ, facing reads from the windscreen and light strip, one-way arrows are shape-coded, slicks carry a texture, and ambulances keep a cream body and a red cross whatever livery is equipped. On top of that sit three colourblind palette remaps, a high-contrast mode, reduced motion, three haptic levels, a left-handed layout, calm honks, and text scaling to 130% without layout breaks.

## Testing

`npm test` runs 109 unit tests: sim geometry and every modifier, solver optimality and dead-end detection, the full 320-level campaign audited for validity, solvability, par, band mix, gate compliance and difficulty scaling, plus the economy and save layers.

`npm run smoke` is the one that catches what unit tests cannot. It boots the real game in Chromium at phone resolution, clears levels by dispatching genuine pointer events, drags a blocked car to check it bumps rather than escapes, undoes a slide, opens a hint, plays a Night Shift lot, walks every meta screen, and fails on any console error, page exception, failed request, stacked modal or empty screen. It writes screenshots to `/tmp/gridlock-shots` for eyeballing.

`window.__gridlock` exposes the live sim for that harness — which car can leave, where a cell lands on screen, and a `jumpTo(level)` that goes through the app rather than racing the save file.

## What is not here

This is the game, not the service. There is no backend, so anything that needs one is either absent or honestly labelled: Rush Hour shows a clear-rate *estimated from the jam's own measured shape* rather than a fabricated community figure, leaderboards and friends are out, and the ad placements are simulations. Cloud save, LiveOps tooling, attribution and the analytics pipeline are service-side concerns the design document covers and this build does not pretend to have.
