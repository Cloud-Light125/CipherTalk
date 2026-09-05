import type { ReactNode } from 'react'
import { Alert, Button, Chip, Separator, Typography } from '@heroui/react'
import { ArrowUpRightFromSquare, LogoGithub, ShieldCheck } from '@gravity-ui/icons'
import { formatDisplayVersion } from '../../../lib/appVersion'

interface AboutTabProps {
  appVersion: string
}

const PROJECT_URL = 'https://github.com/Cloud-Light125/CipherTalk'
const PROJECT_DISPLAY_NAME = 'Cloud-Light125/CipherTalk'
const MAINTAINER_URL = 'https://github.com/Cloud-Light125'
const WEBSITE_URL = 'https://269332.xyz'

const ORIGINAL_PROJECT_URL = 'https://github.com/ILoveBingLu/CipherTalk'
const ORIGINAL_WEBSITE_URL = 'https://miyu.aiqji.com'

interface ExternalLinkProps {
  href: string
  onOpen: (url: string) => void
  children: ReactNode
  className?: string
}

function ExternalLink({ href, onOpen, children, className = '' }: ExternalLinkProps) {
  return (
    <a
      href={href}
      onClick={(event) => {
        event.preventDefault()
        onOpen(href)
      }}
      className={`min-w-0 max-w-full break-words underline decoration-border underline-offset-4 transition-colors hover:text-accent-foreground ${className}`}
    >
      {children}
    </a>
  )
}

function AboutTab({ appVersion }: AboutTabProps) {
  const openExternal = (url: string) => {
    void window.electronAPI.shell.openExternal(url)
  }

  const openAgreement = () => {
    void window.electronAPI.window.openAgreementWindow()
  }

  return (
    <div className="tab-content flex min-h-full flex-col gap-8">
      <section className="flex flex-col gap-6 pb-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-col items-start gap-5 sm:flex-row sm:items-center">
          <img
            src="./About.png"
            alt="CloudLight WeChat"
            className="pointer-events-none h-auto w-32 shrink-0 object-contain select-none"
          />
          <div className="min-w-0 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Typography.Heading level={2} className="text-2xl font-semibold text-foreground">
                CloudLight WeChat
              </Typography.Heading>
              <Chip size="sm" variant="soft">
                <Chip.Label>{appVersion ? formatDisplayVersion(appVersion) : 'v...'}</Chip.Label>
              </Chip>
            </div>
            <Typography.Paragraph size="sm" color="muted" className="max-w-2xl">
              本地优先的微信数据浏览、检索与分析工具，面向个人数据归档与回顾场景。
            </Typography.Paragraph>
            <div className="flex flex-wrap items-center gap-2">
              <Chip size="sm" color="success" variant="soft">
                <Chip.Label>本地运行</Chip.Label>
              </Chip>
              <Chip size="sm" variant="secondary">
                <Chip.Label>本地数据</Chip.Label>
              </Chip>
              <Chip size="sm" variant="secondary">
                <Chip.Label>免费软件</Chip.Label>
              </Chip>
            </div>
          </div>
        </div>
      </section>

      <Separator />

      <section className="space-y-4">
        <div className="space-y-1">
          <Typography.Heading level={3} className="text-lg font-semibold text-foreground">版本信息</Typography.Heading>
          <Typography.Paragraph size="sm" color="muted">当前安装版本与数据处理模式。</Typography.Paragraph>
        </div>
        <dl className="grid gap-4 rounded-xl border border-border bg-surface p-5 sm:grid-cols-2">
          <div className="space-y-1">
            <dt className="text-xs text-muted">当前版本</dt>
            <dd className="text-sm font-medium text-foreground">{appVersion ? formatDisplayVersion(appVersion) : 'v...'}</dd>
          </div>
          <div className="space-y-1">
            <dt className="text-xs text-muted">数据模式</dt>
            <dd className="text-sm font-medium text-foreground">本地优先</dd>
          </div>
        </dl>
      </section>

      <Separator />

      <section className="space-y-4">
        <div className="space-y-1">
          <Typography.Heading level={3} className="text-lg font-semibold text-foreground">当前项目信息</Typography.Heading>
          <Typography.Paragraph size="sm" color="muted">本版本由 Cloud-Light125 继续维护。</Typography.Paragraph>
        </div>
        <dl className="grid min-w-0 gap-x-6 gap-y-5 rounded-xl border border-border bg-surface p-5 sm:grid-cols-2">
          <div className="min-w-0 space-y-1">
            <dt className="text-xs text-muted">当前维护者</dt>
            <dd className="min-w-0 text-sm font-medium text-foreground">
              <ExternalLink href={MAINTAINER_URL} onOpen={openExternal} className="inline-flex items-center gap-2">
                <LogoGithub width={16} height={16} className="shrink-0" />
                <span>Cloud-Light125</span>
                <ArrowUpRightFromSquare width={13} height={13} className="shrink-0" />
              </ExternalLink>
            </dd>
          </div>
          <div className="min-w-0 space-y-1">
            <dt className="text-xs text-muted">项目仓库</dt>
            <dd className="min-w-0 text-sm font-medium text-foreground">
              <ExternalLink href={PROJECT_URL} onOpen={openExternal} className="inline-flex items-center gap-2">
                <LogoGithub width={16} height={16} className="shrink-0" />
                <span className="break-all">{PROJECT_DISPLAY_NAME}</span>
                <ArrowUpRightFromSquare width={13} height={13} className="shrink-0" />
              </ExternalLink>
            </dd>
          </div>
          <div className="min-w-0 space-y-1 sm:col-span-2">
            <dt className="text-xs text-muted">个人主页</dt>
            <dd className="min-w-0 text-sm font-medium text-foreground">
              <ExternalLink href={WEBSITE_URL} onOpen={openExternal} className="inline-flex items-center gap-2">
                <span>269332.xyz</span>
                <ArrowUpRightFromSquare width={13} height={13} className="shrink-0" />
              </ExternalLink>
            </dd>
          </div>
        </dl>
      </section>

      <section className="space-y-4">
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>免费软件声明</Alert.Title>
            <Alert.Description>
              本软件免费提供。如发现未经授权的付费售卖或二次分发，请谨慎辨别，并优先从官方渠道获取。
            </Alert.Description>
          </Alert.Content>
        </Alert>
        <div className="rounded-lg border border-border/60 bg-surface/40 px-4 py-3">
          <Typography.Paragraph size="xs" color="muted">
            用户协议与许可信息
          </Typography.Paragraph>
          <Button type="button" variant="outline" size="sm" className="mt-2" onPress={openAgreement}>
            <ShieldCheck width={16} height={16} />
            打开用户协议
          </Button>
        </div>
      </section>

      <section className="mt-auto space-y-2 pt-2">
        <Separator />
        <Typography.Paragraph size="xs" color="muted" className="mx-auto max-w-2xl text-center text-[11px] leading-4 opacity-75">
          <span className="block">
            本项目基于{' '}
            <ExternalLink href={ORIGINAL_PROJECT_URL} onOpen={openExternal}>ILoveBingLu/CipherTalk</ExternalLink>{' '}
            继续维护
          </span>
          <span className="block">
            原作者{' '}
            <ExternalLink href={ORIGINAL_PROJECT_URL} onOpen={openExternal}>ILoveBingLu</ExternalLink>
            <span className="mx-1">·</span>
            <ExternalLink href={ORIGINAL_PROJECT_URL} onOpen={openExternal}>原仓库</ExternalLink>
            <span className="mx-1">·</span>
            <ExternalLink href={ORIGINAL_WEBSITE_URL} onOpen={openExternal}>原官网</ExternalLink>
          </span>
        </Typography.Paragraph>
      </section>
    </div>
  )
}

export default AboutTab
