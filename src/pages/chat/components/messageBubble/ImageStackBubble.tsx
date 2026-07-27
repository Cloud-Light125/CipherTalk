import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { ChevronLeft, ChevronRight } from '@gravity-ui/icons'

import type { ChatSession, Message } from '../../../../types/models'
import { getMessageDomKey } from '../../utils/messageKeys'
import ImageBubble from './ImageBubble'

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
const IMAGE_STACK_WIDTH = 180
const IMAGE_STACK_HEIGHT = 240

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
  const switchTimerRef = useRef<number | null>(null)

  const activeIndex = useMemo(() => {
    const index = messages.findIndex(message => getMessageDomKey(message) === activeMessageKey)
    return index >= 0 ? index : messages.length - 1
  }, [activeMessageKey, messages])
  const activeMessage = messages[activeIndex]
  const previousMessage = activeIndex > 0
    ? messages[activeIndex - 1]
    : undefined
  const nextMessage = activeIndex < messages.length - 1
    ? messages[activeIndex + 1]
    : undefined
  const stackStyle = {
    '--image-stack-width': `${IMAGE_STACK_WIDTH}px`,
    '--image-stack-height': `${IMAGE_STACK_HEIGHT}px`
  } as CSSProperties

  useEffect(() => {
    return () => {
      if (switchTimerRef.current !== null) {
        window.clearTimeout(switchTimerRef.current)
      }
    }
  }, [])

  const switchImage = (direction: SwitchDirection) => {
    if (messages.length < 2 || switchDirection) return

    const offset = direction === 'next' ? 1 : -1
    const targetIndex = activeIndex + offset
    if (targetIndex < 0 || targetIndex >= messages.length) return
    const targetMessageKey = getMessageDomKey(messages[targetIndex])

    setSwitchDirection(direction)
    const duration = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ? 0
      : CARD_SWITCH_DURATION
    switchTimerRef.current = window.setTimeout(() => {
      setActiveMessageKey(targetMessageKey)
      setSwitchDirection(null)
      switchTimerRef.current = null
    }, duration)
  }

  return (
    <div
      className={`image-stack${switchDirection ? ` is-switching-${switchDirection}` : ''}`}
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

      <div className="image-stack__stage">
        <div className="image-stack__layer image-stack__layer--left" aria-hidden="true">
          {previousMessage && (
            <ImageBubble
              key={getMessageDomKey(previousMessage)}
              message={previousMessage}
              session={session}
              hasImageKey={hasImageKey}
            />
          )}
        </div>
        <div className="image-stack__layer image-stack__layer--right" aria-hidden="true">
          {nextMessage && (
            <ImageBubble
              key={getMessageDomKey(nextMessage)}
              message={nextMessage}
              session={session}
              hasImageKey={hasImageKey}
            />
          )}
        </div>
        <div className="image-stack__front">
          <ImageBubble
            key={getMessageDomKey(activeMessage)}
            message={activeMessage}
            session={session}
            hasImageKey={hasImageKey}
            onContextMenu={onContextMenu}
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
