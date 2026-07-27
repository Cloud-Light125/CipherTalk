import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { ChevronLeft, ChevronRight } from '@gravity-ui/icons'

import type { ChatSession, Message } from '../../../../types/models'
import { getMessageDomKey } from '../../utils/messageKeys'
import ImageBubble from './ImageBubble'
import { imageDataUrlCache, subscribeImageCacheResolved } from './mediaState'

interface ImageStackBubbleProps {
  messages: Message[]
  count: number
  session: ChatSession
  hasImageKey?: boolean
  onExpand: () => void
  onContextMenu?: (e: React.MouseEvent, message: Message, handlers?: any) => void
}

type SwitchDirection = 'previous' | 'next'

const CARD_SWITCH_DURATION = 360
const DRAG_SWITCH_DURATION = 240
const DRAG_SETTLE_DURATION = 180
const DRAG_SWITCH_DISTANCE = 54
const DRAG_VELOCITY_DISTANCE = 18
const DRAG_SWITCH_VELOCITY = 0.45
const DRAG_MAX_OFFSET = 144
const IMAGE_HANDOFF_TIMEOUT = 500
const IMAGE_STACK_WIDTH = 180
const IMAGE_STACK_HEIGHT = 240
const IMAGE_STACK_CARD_STEP = 8
const MAX_VISIBLE_STACK_DEPTH = 2
const STACK_BUFFER_DEPTH = MAX_VISIBLE_STACK_DEPTH + 1
const STACK_TARGET_Z_INDEX = 19
const STACK_PROMOTED_Z_INDEX = 24
const STACK_LAYER_SWAP_PROGRESS = 0.8

interface StackLayerPose {
  x: number
  rotation: number
  scale: number
  zIndex: number
}

interface PointerDragState {
  pointerId: number
  startX: number
  lastX: number
  lastTime: number
  velocityX: number
  offset: number
  maxDistance: number
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value))
}

function interpolateStackLayerPose(from: StackLayerPose, to: StackLayerPose, progress: number): StackLayerPose {
  return {
    x: from.x + (to.x - from.x) * progress,
    rotation: from.rotation + (to.rotation - from.rotation) * progress,
    scale: from.scale + (to.scale - from.scale) * progress,
    zIndex: progress < STACK_LAYER_SWAP_PROGRESS ? from.zIndex : to.zIndex
  }
}

function getStackLayerPose(messageIndex: number, activeIndex: number): StackLayerPose {
  const relativeIndex = messageIndex - activeIndex
  const windowStartIndex = Math.max(0, activeIndex - MAX_VISIBLE_STACK_DEPTH)
  if (relativeIndex === 0) {
    return {
      x: (messageIndex - windowStartIndex) * IMAGE_STACK_CARD_STEP,
      rotation: 0,
      scale: 1,
      zIndex: 20
    }
  }

  const side = relativeIndex < 0 ? -1 : 1
  const depth = Math.abs(relativeIndex)

  return {
    x: (messageIndex - windowStartIndex) * IMAGE_STACK_CARD_STEP,
    rotation: side * (2 + Math.min(depth, 4) * 0.5),
    scale: Math.max(0.72, 0.96 - depth * 0.04),
    zIndex: Math.max(1, 10 - depth)
  }
}

function getDisplayedStackLayerPose(messageIndex: number, activeIndex: number): StackLayerPose {
  const pose = getStackLayerPose(messageIndex, activeIndex)
  const relativeIndex = messageIndex - activeIndex
  const depth = Math.abs(relativeIndex)
  if (depth <= MAX_VISIBLE_STACK_DEPTH) return pose

  const side = relativeIndex < 0 ? -1 : 1
  const coverIndex = activeIndex + side * MAX_VISIBLE_STACK_DEPTH
  const coverPose = getStackLayerPose(coverIndex, activeIndex)

  return {
    ...coverPose,
    zIndex: Math.min(pose.zIndex, coverPose.zIndex - 1)
  }
}

function getStackLayerStyle(
  currentPose: StackLayerPose,
  targetPose: StackLayerPose
) {
  return {
    '--image-stack-layer-x': `${currentPose.x}px`,
    '--image-stack-layer-rotation': `${currentPose.rotation}deg`,
    '--image-stack-layer-scale': currentPose.scale,
    '--image-stack-layer-z': currentPose.zIndex,
    '--image-stack-target-x': `${targetPose.x}px`,
    '--image-stack-target-rotation': `${targetPose.rotation}deg`,
    '--image-stack-target-scale': targetPose.scale,
    '--image-stack-target-z': targetPose.zIndex
  } as CSSProperties
}

function getImageCacheKey(message: Message) {
  return message.imageMd5 || message.imageDatName || `local:${message.localId}`
}

function CachedStackPreview({ message }: { message: Message }) {
  const cacheKey = getImageCacheKey(message)
  const [localPath, setLocalPath] = useState(() => imageDataUrlCache.get(cacheKey))

  useEffect(() => {
    return subscribeImageCacheResolved((payload) => {
      const matches =
        payload.cacheKey === cacheKey ||
        (payload.imageMd5 && payload.imageMd5 === message.imageMd5) ||
        (payload.imageDatName && payload.imageDatName === message.imageDatName)
      if (matches) {
        imageDataUrlCache.set(cacheKey, payload.localPath)
        setLocalPath(payload.localPath)
      }
    })
  }, [cacheKey, message.imageDatName, message.imageMd5])

  if (!localPath) {
    return <div className="image-stack__preview-placeholder" />
  }

  return (
    <img
      src={localPath}
      alt=""
      className="image-stack__preview-image"
      decoding="async"
      onError={() => setLocalPath(undefined)}
    />
  )
}

function ImageStackBubble({
  messages,
  count,
  session,
  hasImageKey,
  onExpand,
  onContextMenu
}: ImageStackBubbleProps) {
  const firstMessage = messages[0]
  const [activeMessageKey, setActiveMessageKey] = useState(() => getMessageDomKey(firstMessage))
  const [switchDirection, setSwitchDirection] = useState<SwitchDirection | null>(null)
  const [dragOffset, setDragOffset] = useState(0)
  const [isDragging, setIsDragging] = useState(false)
  const [isDragSettling, setIsDragSettling] = useState(false)
  const [switchFromDrag, setSwitchFromDrag] = useState(false)
  const [handoffMessageKey, setHandoffMessageKey] = useState<string | null>(null)
  const switchTimerRef = useRef<number | null>(null)
  const handoffTimerRef = useRef<number | null>(null)
  const dragSettleTimerRef = useRef<number | null>(null)
  const suppressClickTimerRef = useRef<number | null>(null)
  const pointerDragRef = useRef<PointerDragState | null>(null)
  const suppressClickRef = useRef(false)

  const clearImageHandoff = useCallback(() => {
    if (handoffTimerRef.current !== null) {
      window.clearTimeout(handoffTimerRef.current)
      handoffTimerRef.current = null
    }
    setHandoffMessageKey(null)
  }, [])

  const activeIndex = useMemo(() => {
    const index = messages.findIndex(message => getMessageDomKey(message) === activeMessageKey)
    return index >= 0 ? index : messages.length - 1
  }, [activeMessageKey, messages])
  const activeMessage = messages[activeIndex]
  const switchTargetIndex = switchDirection === 'next'
    ? activeIndex + 1
    : switchDirection === 'previous'
      ? activeIndex - 1
      : activeIndex
  const dragDirection: SwitchDirection | null = dragOffset < -0.5 && activeIndex < messages.length - 1
    ? 'next'
    : dragOffset > 0.5 && activeIndex > 0
      ? 'previous'
      : null
  const dragTargetIndex = dragDirection === 'next'
    ? activeIndex + 1
    : dragDirection === 'previous'
      ? activeIndex - 1
      : activeIndex
  const dragProgress = Math.min(Math.abs(dragOffset) / DRAG_MAX_OFFSET, 1)
  const dragRotation = clamp(dragOffset / 12, -12, 12)
  const dragScale = 1 - Math.min(Math.abs(dragOffset) / 144, 1) * 0.04
  const activePose = getStackLayerPose(activeIndex, activeIndex)
  const switchedActivePose = getStackLayerPose(activeIndex, switchTargetIndex)
  const stackStyle = {
    '--image-stack-width': `${IMAGE_STACK_WIDTH}px`,
    '--image-stack-height': `${IMAGE_STACK_HEIGHT}px`,
    '--image-stack-stage-width': `${IMAGE_STACK_WIDTH + Math.min(messages.length - 1, MAX_VISIBLE_STACK_DEPTH * 2) * IMAGE_STACK_CARD_STEP}px`,
    '--image-stack-front-left': `${activePose.x}px`,
    '--image-stack-front-target-x': `${switchedActivePose.x - activePose.x}px`,
    '--image-stack-drag-x': `${dragOffset}px`,
    '--image-stack-drag-rotation': `${dragRotation}deg`,
    '--image-stack-drag-scale': dragScale
  } as CSSProperties

  useEffect(() => {
    return () => {
      if (switchTimerRef.current !== null) {
        window.clearTimeout(switchTimerRef.current)
      }
      if (dragSettleTimerRef.current !== null) {
        window.clearTimeout(dragSettleTimerRef.current)
      }
      if (handoffTimerRef.current !== null) {
        window.clearTimeout(handoffTimerRef.current)
      }
      if (suppressClickTimerRef.current !== null) {
        window.clearTimeout(suppressClickTimerRef.current)
      }
    }
  }, [])

  const switchImage = (direction: SwitchDirection, initialDragOffset = 0, fromDrag = false) => {
    if (messages.length < 2 || switchDirection) return

    const offset = direction === 'next' ? 1 : -1
    const targetIndex = activeIndex + offset
    if (targetIndex < 0 || targetIndex >= messages.length) return
    const targetMessageKey = getMessageDomKey(messages[targetIndex])

    if (dragSettleTimerRef.current !== null) {
      window.clearTimeout(dragSettleTimerRef.current)
      dragSettleTimerRef.current = null
    }
    clearImageHandoff()
    setIsDragSettling(false)
    setSwitchFromDrag(fromDrag)
    setDragOffset(initialDragOffset)
    setSwitchDirection(direction)
    const duration = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ? 0
      : fromDrag
        ? DRAG_SWITCH_DURATION
        : CARD_SWITCH_DURATION
    switchTimerRef.current = window.setTimeout(() => {
      const targetMessage = messages[targetIndex]
      if (imageDataUrlCache.get(getImageCacheKey(targetMessage))) {
        setHandoffMessageKey(targetMessageKey)
        handoffTimerRef.current = window.setTimeout(() => {
          setHandoffMessageKey(null)
          handoffTimerRef.current = null
        }, IMAGE_HANDOFF_TIMEOUT)
      }
      setActiveMessageKey(targetMessageKey)
      setSwitchDirection(null)
      setSwitchFromDrag(false)
      setDragOffset(0)
      switchTimerRef.current = null
    }, duration)
  }

  const settleDrag = () => {
    setIsDragging(false)
    setIsDragSettling(true)
    setDragOffset(0)
    dragSettleTimerRef.current = window.setTimeout(() => {
      setIsDragSettling(false)
      dragSettleTimerRef.current = null
    }, DRAG_SETTLE_DURATION)
  }

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || switchDirection) return
    const target = event.target as HTMLElement
    if (!target.closest('.image-stack__front') || target.closest('button')) return

    if (dragSettleTimerRef.current !== null) {
      window.clearTimeout(dragSettleTimerRef.current)
      dragSettleTimerRef.current = null
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    pointerDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      lastX: event.clientX,
      lastTime: event.timeStamp,
      velocityX: 0,
      offset: 0,
      maxDistance: 0
    }
    setIsDragSettling(false)
    setIsDragging(true)
    setDragOffset(0)
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = pointerDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return

    const rawOffset = event.clientX - drag.startX
    const canSwitch = rawOffset < 0
      ? activeIndex < messages.length - 1
      : rawOffset > 0
        ? activeIndex > 0
        : true
    const nextOffset = canSwitch
      ? clamp(rawOffset, -DRAG_MAX_OFFSET, DRAG_MAX_OFFSET)
      : clamp(rawOffset * 0.18, -28, 28)
    const elapsed = Math.max(event.timeStamp - drag.lastTime, 1)
    const instantVelocity = (event.clientX - drag.lastX) / elapsed

    drag.velocityX = drag.velocityX * 0.65 + instantVelocity * 0.35
    drag.lastX = event.clientX
    drag.lastTime = event.timeStamp
    drag.offset = nextOffset
    drag.maxDistance = Math.max(drag.maxDistance, Math.abs(rawOffset))
    setDragOffset(nextOffset)
  }

  const finishPointerDrag = (event: React.PointerEvent<HTMLDivElement>, cancelled = false) => {
    const drag = pointerDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return

    pointerDragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (drag.maxDistance > 5) {
      suppressClickRef.current = true
      if (suppressClickTimerRef.current !== null) {
        window.clearTimeout(suppressClickTimerRef.current)
      }
      suppressClickTimerRef.current = window.setTimeout(() => {
        suppressClickRef.current = false
        suppressClickTimerRef.current = null
      }, 250)
    }

    const direction: SwitchDirection | null = drag.offset < 0
      ? activeIndex < messages.length - 1 ? 'next' : null
      : drag.offset > 0 && activeIndex > 0
        ? 'previous'
        : null
    const hasDistance = Math.abs(drag.offset) >= DRAG_SWITCH_DISTANCE
    const releaseVelocity = event.timeStamp - drag.lastTime > 80 ? 0 : drag.velocityX
    const hasVelocity = Math.abs(drag.offset) >= DRAG_VELOCITY_DISTANCE &&
      Math.abs(releaseVelocity) >= DRAG_SWITCH_VELOCITY

    setIsDragging(false)
    if (!cancelled && direction && (hasDistance || hasVelocity)) {
      switchImage(direction, drag.offset, true)
      return
    }
    settleDrag()
  }

  return (
    <div
      className={`image-stack${switchDirection ? ` is-switching-${switchDirection}` : ''}${isDragging ? ' is-dragging' : ''}${isDragSettling ? ' is-drag-settling' : ''}${switchFromDrag ? ' is-completing-drag' : ''}`}
      style={stackStyle}
      onContextMenu={event => event.stopPropagation()}
    >
      <button
        type="button"
        className="image-stack__expand"
        title={`展开 ${count} 张图片`}
        onClick={(event) => {
          event.stopPropagation()
          onExpand()
        }}
      >
        展开 {count}
      </button>

      <div
        className="image-stack__stage"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={event => finishPointerDrag(event)}
        onPointerCancel={event => finishPointerDrag(event, true)}
        onLostPointerCapture={event => finishPointerDrag(event, true)}
        onDragStart={event => event.preventDefault()}
        onClickCapture={(event) => {
          if (!suppressClickRef.current) return
          suppressClickRef.current = false
          event.preventDefault()
          event.stopPropagation()
        }}
      >
        {messages.map((message, messageIndex) => {
          const messageKey = getMessageDomKey(message)
          const isHandoffLayer = messageIndex === activeIndex && messageKey === handoffMessageKey
          if (messageIndex === activeIndex && !isHandoffLayer) return null

          const currentDepth = Math.abs(messageIndex - activeIndex)
          if (!isHandoffLayer && currentDepth > STACK_BUFFER_DEPTH) return null

          const currentPose = getDisplayedStackLayerPose(messageIndex, activeIndex)
          const targetPose = getDisplayedStackLayerPose(messageIndex, switchTargetIndex)
          let displayedPose = isHandoffLayer
            ? { ...currentPose, zIndex: STACK_PROMOTED_Z_INDEX }
            : currentPose
          if (dragDirection) {
            displayedPose = interpolateStackLayerPose(
              currentPose,
              getDisplayedStackLayerPose(messageIndex, dragTargetIndex),
              dragProgress
            )
            if (messageIndex === dragTargetIndex) {
              displayedPose = {
                ...displayedPose,
                zIndex: dragProgress >= STACK_LAYER_SWAP_PROGRESS
                  ? STACK_PROMOTED_Z_INDEX
                  : STACK_TARGET_Z_INDEX
              }
            }
          }
          const isPromoting = !isHandoffLayer && switchDirection !== null && messageIndex === switchTargetIndex
          const layerSide = isHandoffLayer
            ? 'handoff'
            : messageIndex < activeIndex ? 'left' : 'right'
          const motionClass = isPromoting
            ? ' is-promoting'
            : switchDirection
              ? ' is-reordering'
              : ''

          return (
            <div
              key={messageKey}
              className={`image-stack__layer image-stack__layer--${layerSide}${motionClass}`}
              style={getStackLayerStyle(displayedPose, targetPose)}
              aria-hidden="true"
            >
              <CachedStackPreview message={message} />
            </div>
          )
        })}
        <div className="image-stack__front">
          <ImageBubble
            key={getMessageDomKey(activeMessage)}
            message={activeMessage}
            session={session}
            hasImageKey={hasImageKey}
            onContextMenu={onContextMenu}
            onImageReady={clearImageHandoff}
          />
        </div>

        <button
          type="button"
          className="image-stack__nav image-stack__previous"
          aria-label="查看组内上一张图片"
          title="查看上一张"
          disabled={activeIndex === 0 || switchDirection !== null}
          onClick={(event) => {
            event.stopPropagation()
            switchImage('previous')
          }}
        >
          <ChevronLeft width={18} height={18} />
        </button>

        <button
          type="button"
          className="image-stack__nav image-stack__next"
          aria-label="查看组内下一张图片"
          title="查看下一张"
          disabled={activeIndex === messages.length - 1 || switchDirection !== null}
          onClick={(event) => {
            event.stopPropagation()
            switchImage('next')
          }}
        >
          <ChevronRight width={18} height={18} />
        </button>
      </div>
    </div>
  )
}

export default ImageStackBubble
