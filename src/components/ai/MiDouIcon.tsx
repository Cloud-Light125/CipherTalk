import { useId } from 'react'

interface MiDouIconProps {
  width?: number | string
  height?: number | string
  className?: string
}

/**
 * 密豆图标：一颗带裂缝的豆粒，走 currentColor 继承文字颜色，
 * width/height 属性与 gravity-ui 图标一致，可直接替换使用。
 */
export default function MiDouIcon({ width = 16, height = 16, className }: MiDouIconProps) {
  // 同一页面会渲染多个图标，mask id 必须唯一
  const maskId = useId()
  return (
    <svg
      aria-hidden="true"
      className={className}
      focusable="false"
      width={width}
      height={height}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g transform="rotate(-42 8 8)">
        <mask id={maskId} maskUnits="userSpaceOnUse" x="-2" y="-2" width="20" height="20">
          <ellipse cx="8" cy="8" rx="6" ry="4.7" fill="#fff" />
          {/* 豆粒中间的 S 形裂缝：不顶到边缘、圆头收尾，外轮廓保持圆润 */}
          <path d="M3.4 8 C 6.2 6, 9.8 10, 12.6 8" stroke="#000" strokeWidth="1.6" strokeLinecap="round" fill="none" />
        </mask>
        <ellipse cx="8" cy="8" rx="6" ry="4.7" fill="currentColor" mask={`url(#${maskId})`} />
      </g>
    </svg>
  )
}
