import { compressImage } from '@/composables/useImageCompressor'
import { api, urlBase } from '@/stores/_config'
import { useUserStore } from '@/stores/user'
import { useUtilsStore } from '@/stores/utils'

export interface EmbedUploadedImage {
  attachmentId: string
  url: string
  filename: string
  mimeType: string
  size: number
}

const MAX_FILENAME_LENGTH = 255
const UPLOAD_TIMEOUT_MS = 60_000

const isBlob = (value: unknown): value is Blob => (
  typeof Blob !== 'undefined' && value instanceof Blob
)

const assertDecodableImage = async (file: Blob) => {
  try {
    const bitmap = await createImageBitmap(file)
    bitmap.close()
  } catch {
    throw new Error('INVALID_PARAMS: invalid image data')
  }
}

const defaultFilename = (mimeType: string) => {
  const extension = mimeType.split('/')[1]?.split(/[;+]/, 1)[0]?.trim().toLowerCase()
  return extension ? `image.${extension === 'jpeg' ? 'jpg' : extension}` : 'image'
}

const normalizeFile = (file: File | Blob, filename?: string): File => {
  if (!isBlob(file)) throw new Error('INVALID_PARAMS: file must be a Blob or File')
  const requestedName = typeof filename === 'string' ? filename.trim() : ''
  if (requestedName.length > MAX_FILENAME_LENGTH) throw new Error('INVALID_PARAMS: filename is too long')
  const isFile = typeof File !== 'undefined' && file instanceof File
  const originalName = isFile && file.name ? file.name : defaultFilename(file.type)
  const name = requestedName || originalName || 'image'
  if (isFile && file.name === name) return file
  return new File([file], name, {
    type: file.type,
    lastModified: isFile ? file.lastModified : Date.now(),
  })
}

const attachmentIdFromResponse = (value: unknown): string => {
  if (Array.isArray(value)) {
    if (value.length !== 1) return ''
    return typeof value[0] === 'string' ? value[0].trim() : ''
  }
  return typeof value === 'string' ? value.trim() : ''
}

const toUploadError = (error: any, fallback: string) => {
  const status = Number(error?.response?.status)
  if (status === 401 || status === 403) return new Error('SESSION_EXPIRED: Login required')
  if (status === 413) return new Error('PAYLOAD_TOO_LARGE: 图片文件过大')
  return error instanceof Error ? error : new Error(fallback)
}

const buildAttachmentUrl = (attachmentId: string) => {
  const base = new URL(`${String(urlBase || '').replace(/\/+$/, '')}/`, window.location.href)
  return new URL(`api/v1/attachment/${encodeURIComponent(attachmentId)}`, base).toString()
}

export const uploadChannelEmbedImage = async (
  file: File | Blob,
  filename?: string,
): Promise<EmbedUploadedImage> => {
  const normalized = normalizeFile(file, filename)
  const mimeType = normalized.type.trim().toLowerCase()
  if (!mimeType.startsWith('image/')) throw new Error('INVALID_PARAMS: only image files are supported')

  const utils = useUtilsStore()
  const sizeLimit = Number(utils.fileSizeLimit)

  const user = useUserStore()
  if (!user.token || !user.info?.id) throw new Error('SESSION_EXPIRED: Login required')

  const uploadFile = mimeType === 'image/gif' ? normalized : await compressImage(normalized)
  await assertDecodableImage(uploadFile)
  if (Number.isFinite(sizeLimit) && sizeLimit > 0 && uploadFile.size > sizeLimit) {
    throw new Error('PAYLOAD_TOO_LARGE: 图片文件过大')
  }

  const formData = new FormData()
  formData.append('file', uploadFile, uploadFile.name)
  const headers = { Authorization: user.token }

  let response
  try {
    response = await api.post('api/v1/attachment-upload', formData, {
      headers,
      timeout: UPLOAD_TIMEOUT_MS,
    })
  } catch (error) {
    throw toUploadError(error, '上传失败，请稍后重试')
  }

  const attachmentId = attachmentIdFromResponse(response.data?.ids)
  if (!attachmentId) throw new Error('INTERNAL_ERROR: upload response did not contain an attachment id')

  try {
    await api.post('api/v1/attachment-confirm', {
      ids: [attachmentId],
      isTemp: false,
    }, {
      headers,
      timeout: UPLOAD_TIMEOUT_MS,
    })
  } catch (error) {
    throw toUploadError(error, '附件确认失败，请稍后重试')
  }

  return {
    attachmentId,
    url: buildAttachmentUrl(attachmentId),
    filename: uploadFile.name,
    mimeType: uploadFile.type || mimeType,
    size: uploadFile.size,
  }
}
