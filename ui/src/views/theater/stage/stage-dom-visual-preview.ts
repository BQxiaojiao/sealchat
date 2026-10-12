import type Konva from 'konva'
import { shallowReactive } from 'vue'

import { WORLD_UNIT_PX, type StageObject } from '../shared/stage-types'

// Edit-view-only placement of a DOM visual while a Konva drag/transform is in progress.
// Same fields and units as StageObject.transform; never written to StageStore.
export type StageDomVisualTransform = Pick<StageObject['transform'], 'x' | 'y' | 'rotation' | 'scaleX' | 'scaleY'>

// Konva object nodes carry x/y/rotation/scale exactly as updateObjectNode sets them from
// object.transform, so reading them back mirrors the DOM style without baking width/height.
// Keeping width/height untouched during a resize means the iframe/text box is only
// CSS-scaled per frame and reflows once, when the formal transform is committed.
export const stageDomVisualTransformFromNode = (node: Konva.Node): StageDomVisualTransform => ({
  x: node.x() / WORLD_UNIT_PX,
  y: node.y() / WORLD_UNIT_PX,
  rotation: node.rotation(),
  scaleX: node.scaleX(),
  scaleY: node.scaleY(),
})

export const resolveStageDomVisualTransform = (
  object: StageObject,
  previews: Readonly<Record<string, StageDomVisualTransform>> | undefined,
): StageDomVisualTransform => previews?.[object.id] || object.transform

export interface StageDomVisualPreviewOptions {
  getNode: (objectId: string) => Konva.Node | undefined
  // Only roots rendered by the DOM visual overlay need a preview; pure canvas objects skip it.
  hasDomVisual: (objectId: string) => boolean
  requestFrame?: (callback: () => void) => number
  cancelFrame?: (handle: number) => void
}

export const createStageDomVisualPreview = ({
  getNode,
  hasDomVisual,
  requestFrame = callback => window.requestAnimationFrame(callback),
  cancelFrame = handle => window.cancelAnimationFrame(handle),
}: StageDomVisualPreviewOptions) => {
  const transforms = shallowReactive<Record<string, StageDomVisualTransform>>({})
  // DOM-visual membership cannot change mid-gesture; cache it until the gesture clears.
  const domVisualIds = new Map<string, boolean>()
  const pendingIds = new Set<string>()
  let frame: number | null = null

  const flush = () => {
    frame = null
    pendingIds.forEach((objectId) => {
      const node = getNode(objectId)
      if (node) transforms[objectId] = stageDomVisualTransformFromNode(node)
    })
    pendingIds.clear()
  }

  // Coalesces high-frequency dragmove/transform events into one sync per animation frame.
  const schedule = (objectIds: Iterable<string>) => {
    for (const objectId of objectIds) {
      let domVisual = domVisualIds.get(objectId)
      if (domVisual === undefined) {
        domVisual = hasDomVisual(objectId)
        domVisualIds.set(objectId, domVisual)
      }
      if (domVisual) pendingIds.add(objectId)
    }
    if (pendingIds.size && frame === null) frame = requestFrame(flush)
  }

  // Call in the same task as the formal commit/cancel so the next render uses store state.
  const clear = () => {
    if (frame !== null) cancelFrame(frame)
    frame = null
    pendingIds.clear()
    domVisualIds.clear()
    Object.keys(transforms).forEach((objectId) => {
      delete transforms[objectId]
    })
  }

  return { transforms, schedule, clear }
}
