import assert from 'node:assert/strict'

import { WORLD_UNIT_PX } from '../src/views/theater/shared/stage-types'
import { createTheaterStageStore } from '../src/views/theater/stage/StageStore'
import {
  STAGE_INSERT_CLICK_THRESHOLD_PX,
  normalizeStageInsertRect,
  resolveStageInsertPlacement,
  stageInsertPreviewRect,
  stageWorldPointToViewport,
  viewportPointToStageWorld,
  type StageInsertPlacementOptions,
  type StageInsertPoint,
} from '../src/views/theater/stage/stage-insert-placement'

const viewport = { width: 800, height: 600 }
const camera = { x: 100, y: -50, zoom: 2 }
const identity = (point: StageInsertPoint) => point
const options = (overrides: Partial<StageInsertPlacementOptions> = {}): StageInsertPlacementOptions => ({
  viewport,
  camera,
  unitPx: WORLD_UNIT_PX,
  clickThresholdPx: STAGE_INSERT_CLICK_THRESHOLD_PX,
  minSizePx: 12,
  snapWorldPx: identity,
  gridStepPx: null,
  ...overrides,
})
// Mirrors StageApp.snapStagePosition for a 40x24 field with gridSize 1.
const gridSnap = (point: StageInsertPoint) => {
  const snap = (value: number, field: number) => {
    const origin = -field * WORLD_UNIT_PX / 2
    return origin + Math.round((value - origin) / WORLD_UNIT_PX) * WORLD_UNIT_PX
  }
  return { x: snap(point.x, 40), y: snap(point.y, 24) }
}
const screen = (worldUnits: StageInsertPoint) => stageWorldPointToViewport(
  { x: worldUnits.x * WORLD_UNIT_PX, y: worldUnits.y * WORLD_UNIT_PX },
  viewport,
  camera,
)

// Camera pan + zoom: viewport-local pixels round-trip through world pixels.
assert.deepEqual(viewportPointToStageWorld({ x: 548, y: 274 }, viewport, camera), { x: 24, y: 12 })
assert.deepEqual(stageWorldPointToViewport({ x: 24, y: 12 }, viewport, camera), { x: 548, y: 274 })
assert.deepEqual(viewportPointToStageWorld({ x: 400, y: 300 }, viewport, { x: 0, y: 0, zoom: 1 }), { x: 0, y: 0 })

// Every drag direction yields the same positive-size rectangle and center.
const topLeft = screen({ x: 1, y: 2 })
const bottomRight = screen({ x: 6, y: 4 })
const bottomLeft = { x: topLeft.x, y: bottomRight.y }
const topRight = { x: bottomRight.x, y: topLeft.y }
const expected = { x: 3.5, y: 3, width: 5, height: 2 }
for (const [start, end] of [
  [topLeft, bottomRight],
  [bottomRight, topLeft],
  [bottomLeft, topRight],
  [topRight, bottomLeft],
] as const) {
  assert.deepEqual(resolveStageInsertPlacement(start, end, options()), expected)
  const rect = normalizeStageInsertRect(start, end)
  assert.ok(rect.width > 0 && rect.height > 0)
}
assert.deepEqual(stageInsertPreviewRect(bottomRight, topLeft, options()), {
  left: topLeft.x, top: topLeft.y, width: bottomRight.x - topLeft.x, height: bottomRight.y - topLeft.y,
})

// Tiny drags degrade to a click: center on the press point, no size (store default applies).
const press = screen({ x: -2, y: 1.5 })
const jitter = { x: press.x + 3, y: press.y + 2 }
assert.deepEqual(resolveStageInsertPlacement(press, jitter, options()), { x: -2, y: 1.5 })
assert.equal(stageInsertPreviewRect(press, jitter, options()), null)

// Thin drags keep a minimum size and grow away from the press corner.
const thin = resolveStageInsertPlacement(screen({ x: 0, y: 0 }), screen({ x: 4, y: 0.1 }), options())
assert.equal(thin.width, 4)
assert.equal(thin.height, 0.5)
assert.equal(thin.y, 0.25)

// Grid alignment snaps both corners to grid lines; collapsed axes expand to one grid cell.
const gridOptions = options({ snapWorldPx: gridSnap, gridStepPx: WORLD_UNIT_PX })
assert.deepEqual(
  resolveStageInsertPlacement(screen({ x: 1.2, y: 2.3 }), screen({ x: 5.7, y: 4.4 }), gridOptions),
  { x: 3.5, y: 3, width: 5, height: 2 },
)
assert.deepEqual(
  resolveStageInsertPlacement(screen({ x: 1.2, y: 2.1 }), screen({ x: 5.7, y: 1.6 }), gridOptions),
  { x: 3.5, y: 1.5, width: 5, height: 1 },
)
assert.deepEqual(
  resolveStageInsertPlacement(screen({ x: 1.2, y: 2.2 }), screen({ x: 0.8, y: 1.8 }), gridOptions),
  { x: 0.5, y: 1.5, width: 1, height: 1 },
)

// Store: placement is part of the single "添加对象" history entry.
const store = createTheaterStageStore()
assert.equal(store.canUndo.value, false)
const placed = store.addObject('text', 'scene', expected)
assert.deepEqual(
  { x: placed.transform.x, y: placed.transform.y, width: placed.transform.width, height: placed.transform.height },
  expected,
)
assert.equal(store.state.selectedObjectId, placed.id)
assert.deepEqual(store.selection.selectedIds, [placed.id])
assert.equal(store.undo(), true)
assert.equal(store.activeObjects.value[placed.id], undefined)
assert.equal(store.canUndo.value, false)

// Click placement keeps each type's default size from makeObject.
for (const type of ['text', 'image', 'iframe'] as const) {
  const reference = createTheaterStageStore().addObject(type)
  const clicked = createTheaterStageStore().addObject(type, 'scene', { x: -3, y: 2 })
  assert.deepEqual({ x: clicked.transform.x, y: clicked.transform.y }, { x: -3, y: 2 })
  assert.deepEqual(
    { width: clicked.transform.width, height: clicked.transform.height },
    { width: reference.transform.width, height: reference.transform.height },
  )
  assert.equal(clicked.type, type)
}

// Layering matches plain addObject: above the selected object, else on top.
const layered = createTheaterStageStore()
const base = layered.addObject('text')
const top = layered.addObject('image')
layered.selectObject(base.id)
const aboveBase = layered.addObject('iframe', 'scene', { x: 0, y: 0, width: 4, height: 3 })
assert.equal(aboveBase.parentId, base.parentId)
assert.ok(aboveBase.transform.z > base.transform.z)
assert.ok(aboveBase.transform.z < top.transform.z)
layered.selectObject(null)
const onTop = layered.addObject('image', 'scene', { x: 0, y: 0 })
assert.ok(onTop.transform.z > top.transform.z)

// Inside a group the requested center is a world position.
const grouped = createTheaterStageStore()
const group = grouped.addObject('group')
group.transform.x = 10
group.transform.y = -4
group.transform.scaleX = 2
const sibling = grouped.addObject('text')
sibling.parentId = group.id
grouped.selectObject(sibling.id)
const child = grouped.addObject('text', 'scene', { x: 12, y: -2, width: 4, height: 2 })
assert.equal(child.parentId, group.id)
assert.deepEqual({ x: child.transform.x, y: child.transform.y }, { x: 1, y: 2 })
assert.deepEqual({ width: child.transform.width, height: child.transform.height }, { width: 2, height: 2 })

const assertRotatedGroupPlacement = (rotation: number, scale = 1, alignWithGrid = false) => {
  const rotated = createTheaterStageStore()
  rotated.state.liveState.alignWithGrid = alignWithGrid
  const parent = rotated.addObject('group')
  parent.transform.x = 3
  parent.transform.y = -2
  parent.transform.rotation = rotation
  parent.transform.scaleX = scale
  parent.transform.scaleY = scale
  const reference = rotated.addObject('text')
  reference.parentId = parent.id
  rotated.selectObject(reference.id)

  const placement = { x: 8, y: 5, width: 6, height: 2 }
  const placedChild = rotated.addObject('image', 'scene', placement)
  assert.equal(placedChild.parentId, parent.id)
  assert.ok(Math.abs(placedChild.transform.rotation + rotation) < 1e-6)

  const angle = parent.transform.rotation * Math.PI / 180
  const localX = placedChild.transform.x * parent.transform.scaleX
  const localY = placedChild.transform.y * parent.transform.scaleY
  const worldCenter = {
    x: localX * Math.cos(angle) - localY * Math.sin(angle) + parent.transform.x,
    y: localX * Math.sin(angle) + localY * Math.cos(angle) + parent.transform.y,
  }
  const worldRotation = (parent.transform.rotation + placedChild.transform.rotation) * Math.PI / 180
  const worldWidth = placedChild.transform.width * Math.abs(parent.transform.scaleX)
  const worldHeight = placedChild.transform.height * Math.abs(parent.transform.scaleY)
  const worldBounds = {
    width: Math.abs(Math.cos(worldRotation)) * worldWidth + Math.abs(Math.sin(worldRotation)) * worldHeight,
    height: Math.abs(Math.sin(worldRotation)) * worldWidth + Math.abs(Math.cos(worldRotation)) * worldHeight,
  }

  assert.ok(Math.abs(worldCenter.x - placement.x) < 1e-6)
  assert.ok(Math.abs(worldCenter.y - placement.y) < 1e-6)
  assert.ok(Math.abs(worldBounds.width - placement.width) < 1e-6)
  assert.ok(Math.abs(worldBounds.height - placement.height) < 1e-6)
}

assertRotatedGroupPlacement(90)
assertRotatedGroupPlacement(30, 2, true)

// Grid alignment: drag placements already on grid stay put; click placements bounds-snap like addObject.
const gridded = createTheaterStageStore()
gridded.state.liveState.alignWithGrid = true
const griddedDrag = gridded.addObject('image', 'scene', { x: 3.5, y: 3, width: 5, height: 2 })
assert.deepEqual({ x: griddedDrag.transform.x, y: griddedDrag.transform.y }, { x: 3.5, y: 3 })
const griddedClick = gridded.addObject('text', 'scene', { x: 0.3, y: 0.4 })
const left = griddedClick.transform.x - griddedClick.transform.width / 2
const topEdge = griddedClick.transform.y - griddedClick.transform.height / 2
assert.ok(Math.abs(left - Math.round(left)) < 1e-6)
assert.ok(Math.abs(topEdge - Math.round(topEdge)) < 1e-6)

console.log('theater stage drag-insert placement checks passed')
