import type { StageObjectPlacement } from './StageStore'

export type StageDragInsertType = 'text' | 'image' | 'iframe'

export interface StageInsertPoint {
  x: number
  y: number
}

export interface StageInsertCamera {
  x: number
  y: number
  zoom: number
}

export interface StageInsertViewport {
  width: number
  height: number
}

export interface StageInsertRect {
  left: number
  top: number
  width: number
  height: number
}

export interface StageInsertPlacementOptions {
  viewport: StageInsertViewport
  camera: StageInsertCamera
  unitPx: number
  // Shorter drags fall back to the store's default size centered on the press point.
  clickThresholdPx: number
  // Minimum world-pixel size, matching the Transformer resize floor.
  minSizePx: number
  // Existing grid snapping for world-pixel positions; identity when grid alignment is off.
  snapWorldPx: (point: StageInsertPoint) => StageInsertPoint
  // Grid step in world pixels when grid alignment is on, otherwise null.
  gridStepPx: number | null
}

export const STAGE_INSERT_CLICK_THRESHOLD_PX = 6

const cameraZoom = (camera: StageInsertCamera) => Math.max(0.01, camera.zoom)

// Viewport-local CSS pixels -> world pixels (inverse of the camera group transform).
export const viewportPointToStageWorld = (
  point: StageInsertPoint,
  viewport: StageInsertViewport,
  camera: StageInsertCamera,
): StageInsertPoint => ({
  x: (point.x - viewport.width / 2 - camera.x) / cameraZoom(camera),
  y: (point.y - viewport.height / 2 - camera.y) / cameraZoom(camera),
})

export const stageWorldPointToViewport = (
  point: StageInsertPoint,
  viewport: StageInsertViewport,
  camera: StageInsertCamera,
): StageInsertPoint => ({
  x: point.x * cameraZoom(camera) + viewport.width / 2 + camera.x,
  y: point.y * cameraZoom(camera) + viewport.height / 2 + camera.y,
})

export const normalizeStageInsertRect = (start: StageInsertPoint, end: StageInsertPoint): StageInsertRect => ({
  left: Math.min(start.x, end.x),
  top: Math.min(start.y, end.y),
  width: Math.abs(end.x - start.x),
  height: Math.abs(end.y - start.y),
})

export const isStageInsertClick = (start: StageInsertPoint, end: StageInsertPoint, thresholdPx: number) => (
  Math.hypot(end.x - start.x, end.y - start.y) < thresholdPx
)

const round = (value: number) => Number(value.toFixed(6))

// Both points are viewport-local CSS pixels; the result is in world units for StageStore.addObject.
export const resolveStageInsertPlacement = (
  start: StageInsertPoint,
  end: StageInsertPoint,
  options: StageInsertPlacementOptions,
): StageObjectPlacement => {
  const { viewport, camera, unitPx } = options
  const worldStart = viewportPointToStageWorld(start, viewport, camera)
  if (isStageInsertClick(start, end, options.clickThresholdPx)) {
    return { x: round(worldStart.x / unitPx), y: round(worldStart.y / unitPx) }
  }
  const worldEnd = viewportPointToStageWorld(end, viewport, camera)
  const a = options.snapWorldPx(worldStart)
  const b = options.snapWorldPx(worldEnd)
  const rect = normalizeStageInsertRect(a, b)
  const minimum = Math.max(options.minSizePx, options.gridStepPx || 0)
  const width = Math.max(minimum, rect.width)
  const height = Math.max(minimum, rect.height)
  // Grow collapsed axes in the original drag direction. Snapping can collapse both
  // endpoints onto one grid line, so the snapped a/b points cannot preserve that direction.
  const left = rect.width >= minimum ? rect.left : (worldEnd.x >= worldStart.x ? a.x : a.x - width)
  const top = rect.height >= minimum ? rect.top : (worldEnd.y >= worldStart.y ? a.y : a.y - height)
  return {
    x: round((left + width / 2) / unitPx),
    y: round((top + height / 2) / unitPx),
    width: round(width / unitPx),
    height: round(height / unitPx),
  }
}

// Preview rectangle in viewport-local CSS pixels for the placement that pointerup would create.
export const stageInsertPreviewRect = (
  start: StageInsertPoint,
  end: StageInsertPoint,
  options: StageInsertPlacementOptions,
): StageInsertRect | null => {
  if (isStageInsertClick(start, end, options.clickThresholdPx)) return null
  const placement = resolveStageInsertPlacement(start, end, options)
  const zoom = cameraZoom(options.camera)
  const center = stageWorldPointToViewport(
    { x: placement.x * options.unitPx, y: placement.y * options.unitPx },
    options.viewport,
    options.camera,
  )
  const width = (placement.width || 0) * options.unitPx * zoom
  const height = (placement.height || 0) * options.unitPx * zoom
  return { left: center.x - width / 2, top: center.y - height / 2, width, height }
}
