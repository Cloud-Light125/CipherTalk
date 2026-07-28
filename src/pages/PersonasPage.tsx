import { useCallback, useEffect, useMemo, useRef, useState, type UIEvent } from 'react'
import { Button, SearchField, Tabs } from '@heroui/react'
import { ArrowsRotateLeft, CircleDashed, FaceRobot, PersonPlus, Persons } from '@gravity-ui/icons'
import type { PersonaRecordInfo } from '../types/electron'
import type { ChatSession } from '../types/models'
import { cn } from '../lib/utils'
import PersonaChatPage from './PersonaChatPage'
import { LottieView } from '@/components/LottieView'
import personaOrbUrl from '@/assets/lottie/Anumation.lottie?url'

type ListMode = 'all' | 'cloned'

type PersonaContactItem = {
  sessionId: string
  displayName: string
  avatarUrl?: string
  isGroup?: boolean
  persona?: PersonaRecordInfo
}

type PersonaContactMeta = {
  displayName?: string
  avatarUrl?: string
  isGroup?: boolean
}

const CONTACT_PAGE_SIZE = 120
const PERSONA_ROW_HEIGHT = 64

function getSessionName(session: ChatSession): string {
  return session.displayName?.trim() || session.username
}

function formatCount(persona: PersonaRecordInfo): string {
  const total = persona.stats.friendMessageCount + (persona.stats.groupMessageCount || 0)
  return `${total} 条语料`
}

function isSingleChatSession(session: ChatSession): boolean {
  return Boolean(session.username)
    && !session.username.endsWith('@chatroom')
    && !session.isFoldGroup
    && !session.isOfficialFolder
    && !session.isOfficialAccount
}

function PersonaAvatar({ name, avatarUrl }: { name: string; avatarUrl?: string }) {
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    setFailed(false)
  }, [avatarUrl])

  if (avatarUrl && !failed) {
    return (
      <img
        alt={name}
        className="size-10 shrink-0 rounded-full object-cover"
        draggable={false}
        loading="lazy"
        src={avatarUrl}
        onError={() => setFailed(true)}
      />
    )
  }

  return (
    <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent-soft text-sm font-semibold text-accent-soft-foreground">
      {(name.trim().slice(0, 1) || '?').toUpperCase()}
    </div>
  )
}

function PersonaContactRow({
  item,
  selectedSessionId,
  onSelect,
}: {
  item: PersonaContactItem
  selectedSessionId: string
  onSelect: (sessionId: string) => void
}) {
  const active = item.sessionId === selectedSessionId
  return (
    <div className="h-16 px-2">
      <button
        type="button"
        className={cn(
          'flex h-16 w-full min-w-0 cursor-pointer items-center gap-3 rounded-lg px-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
          active ? 'bg-accent text-accent-foreground' : 'text-foreground hover:bg-(--bg-hover)'
        )}
        onClick={() => onSelect(item.sessionId)}
      >
        <PersonaAvatar name={item.displayName} avatarUrl={item.avatarUrl} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold">{item.displayName}</span>
            {item.isGroup && (
              <span className={cn('shrink-0 text-[11px]', active ? 'text-accent-foreground/75' : 'text-muted')}>群</span>
            )}
          </div>
          <div className={cn('mt-1 truncate text-xs', active ? 'text-accent-foreground/75' : 'text-muted')}>
            {item.persona ? formatCount(item.persona) : '未克隆'}
          </div>
        </div>
        {item.persona && (
          <span className="shrink-0 rounded-full bg-success-soft px-1.5 py-0.5 text-[11px] text-success-soft-foreground">分身</span>
        )}
      </button>
    </div>
  )
}

export default function PersonasPage() {
  const [personas, setPersonas] = useState<PersonaRecordInfo[]>([])
  const [contacts, setContacts] = useState<ChatSession[]>([])
  const [selectedSessionId, setSelectedSessionId] = useState('')
  const [mode, setMode] = useState<ListMode>('all')
  const [keyword, setKeyword] = useState('')
  const [loadingPersonas, setLoadingPersonas] = useState(true)
  const [loadingContacts, setLoadingContacts] = useState(true)
  const [loadingContactsMore, setLoadingContactsMore] = useState(false)
  const [contactsHasMore, setContactsHasMore] = useState(false)
  const [personaContactMeta, setPersonaContactMeta] = useState<Record<string, PersonaContactMeta>>({})
  const [error, setError] = useState('')
  const contactsOffsetRef = useRef(0)
  const loadingContactsMoreRef = useRef(false)
  const contactsRequestSeqRef = useRef(0)
  const contactListRef = useRef<HTMLDivElement>(null)

  const personaBySessionId = useMemo(() => {
    const map = new Map<string, PersonaRecordInfo>()
    for (const persona of personas) map.set(persona.sessionId, persona)
    return map
  }, [personas])

  const contactBySessionId = useMemo(() => {
    const map = new Map<string, ChatSession>()
    for (const contact of contacts) map.set(contact.username, contact)
    return map
  }, [contacts])

  const sortedPersonas = useMemo(() => (
    [...personas].sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0))
  ), [personas])

  const listItems = useMemo<PersonaContactItem[]>(() => {
    if (mode === 'cloned') {
      const normalizedKeyword = keyword.trim().toLocaleLowerCase()
      return sortedPersonas.map((persona) => ({
        sessionId: persona.sessionId,
        displayName: contactBySessionId.get(persona.sessionId)?.displayName?.trim()
          || personaContactMeta[persona.sessionId]?.displayName?.trim()
          || persona.displayName
          || persona.sessionId,
        avatarUrl: contactBySessionId.get(persona.sessionId)?.avatarUrl || personaContactMeta[persona.sessionId]?.avatarUrl,
        isGroup: persona.sessionId.endsWith('@chatroom'),
        persona,
      })).filter((item) => !normalizedKeyword || [item.displayName, item.sessionId]
        .some((value) => value.toLocaleLowerCase().includes(normalizedKeyword)))
    }

    const items: PersonaContactItem[] = contacts.filter(isSingleChatSession).map((contact) => ({
      sessionId: contact.username,
      displayName: getSessionName(contact),
      avatarUrl: contact.avatarUrl,
      persona: personaBySessionId.get(contact.username),
    }))

    return items
  }, [contactBySessionId, contacts, keyword, mode, personaBySessionId, personaContactMeta, sortedPersonas])

  const loadPersonas = useCallback(async () => {
    setLoadingPersonas(true)
    setError('')
    try {
      const result = await window.electronAPI.persona.list()
      if (!result.success) {
        setError(result.error || '读取数字分身失败')
        setPersonas([])
        return
      }
      setPersonas(result.personas || [])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setPersonas([])
    } finally {
      setLoadingPersonas(false)
    }
  }, [])

  const loadContacts = useCallback(async (searchText: string, reset = true) => {
    const trimmed = searchText.trim()
    const offset = reset ? 0 : contactsOffsetRef.current
    if (!reset && loadingContactsMoreRef.current) return
    const requestSeq = ++contactsRequestSeqRef.current

    if (reset) {
      contactsOffsetRef.current = 0
      loadingContactsMoreRef.current = false
      setLoadingContacts(true)
      setLoadingContactsMore(false)
      setContactsHasMore(false)
    } else {
      loadingContactsMoreRef.current = true
      setLoadingContactsMore(true)
    }
    setError('')
    try {
      const result = await window.electronAPI.chat.getMentionTargets(offset, CONTACT_PAGE_SIZE, trimmed)
      if (contactsRequestSeqRef.current !== requestSeq) return
      if (!result.success) {
        setError(result.error || '读取联系人失败')
        if (reset) setContacts([])
        return
      }
      const nextSessions = result.sessions || []
      setContacts((prev) => {
        if (reset) return nextSessions
        const knownSessionIds = new Set(prev.map((session) => session.username))
        return [...prev, ...nextSessions.filter((session) => !knownSessionIds.has(session.username))]
      })
      const hasMore = result.hasMore ?? nextSessions.length >= CONTACT_PAGE_SIZE
      contactsOffsetRef.current = offset + (hasMore ? CONTACT_PAGE_SIZE : nextSessions.length)
      setContactsHasMore(hasMore)
    } catch (e) {
      if (contactsRequestSeqRef.current !== requestSeq) return
      setError(e instanceof Error ? e.message : String(e))
      if (reset) setContacts([])
    } finally {
      if (contactsRequestSeqRef.current !== requestSeq) {
        if (!reset) {
          loadingContactsMoreRef.current = false
          setLoadingContactsMore(false)
        }
        return
      }
      if (reset) {
        setLoadingContacts(false)
      } else {
        loadingContactsMoreRef.current = false
        setLoadingContactsMore(false)
      }
    }
  }, [])

  const refresh = useCallback(() => {
    void loadPersonas()
    void loadContacts(keyword, true)
  }, [keyword, loadContacts, loadPersonas])

  useEffect(() => {
    void loadPersonas()
  }, [loadPersonas])

  useEffect(() => {
    if (personas.length === 0) {
      setPersonaContactMeta({})
      return
    }

    let cancelled = false
    const loadPersonaMeta = async () => {
      const entries = await Promise.all(personas.map(async (persona): Promise<[string, PersonaContactMeta]> => {
        const contact = contactBySessionId.get(persona.sessionId)
        if (contact) {
          return [persona.sessionId, {
            displayName: getSessionName(contact),
            avatarUrl: contact.avatarUrl,
            isGroup: contact.username.endsWith('@chatroom'),
          }]
        }

        try {
          const avatarInfo = await window.electronAPI.chat.getContactAvatar(persona.sessionId)
          return [persona.sessionId, {
            displayName: avatarInfo?.displayName || persona.displayName || persona.sessionId,
            avatarUrl: avatarInfo?.avatarUrl,
            isGroup: persona.sessionId.endsWith('@chatroom'),
          }]
        } catch {
          return [persona.sessionId, {
            displayName: persona.displayName || persona.sessionId,
            isGroup: persona.sessionId.endsWith('@chatroom'),
          }]
        }
      }))
      if (!cancelled) setPersonaContactMeta(Object.fromEntries(entries))
    }

    void loadPersonaMeta()
    return () => { cancelled = true }
  }, [contactBySessionId, personas])

  useEffect(() => {
    if (mode !== 'all') return
    const timer = window.setTimeout(() => {
      void loadContacts(keyword, true)
    }, 220)
    return () => window.clearTimeout(timer)
  }, [keyword, loadContacts, mode])

  const loadMoreContacts = useCallback(() => {
    if (mode !== 'all' || loadingContacts || loadingContactsMore || !contactsHasMore) return
    void loadContacts(keyword, false)
  }, [contactsHasMore, keyword, loadContacts, loadingContacts, loadingContactsMore, mode])

  const handleContactListScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget
    const remaining = element.scrollHeight - element.scrollTop - element.clientHeight
    if (remaining <= PERSONA_ROW_HEIGHT * 2) loadMoreContacts()
  }, [loadMoreContacts])

  useEffect(() => {
    contactListRef.current?.scrollTo({ top: 0 })
  }, [keyword, mode])

  useEffect(() => {
    if (selectedSessionId && !listItems.some((item) => item.sessionId === selectedSessionId)) {
      setSelectedSessionId('')
    }
  }, [listItems, selectedSessionId])

  const loading = loadingContacts || loadingPersonas

  return (
    <div className="flex h-full min-h-0 overflow-hidden bg-(--bg-primary)">
      <aside className="flex min-h-0 w-80 shrink-0 flex-col overflow-hidden border-r border-border/70 bg-surface">
        <div className="shrink-0 border-b border-border/60 px-4 py-4">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h1 className="m-0 text-lg font-semibold text-foreground">AI 克隆</h1>
              <p className="mt-1 text-xs text-muted">{personas.length ? `${personas.length} 个数字分身` : '选择联系人开始克隆'}</p>
            </div>
            <Button isIconOnly size="sm" variant="ghost" aria-label="刷新" isDisabled={loading} onPress={refresh}>
              <ArrowsRotateLeft className={cn('size-4', loading && 'animate-spin')} />
            </Button>
          </div>

          <SearchField
            aria-label="搜索联系人"
            className="mt-4"
            fullWidth
            name="persona-contact-search"
            value={keyword}
            variant="secondary"
            onChange={setKeyword}
          >
            <SearchField.Group>
              <SearchField.SearchIcon />
              <SearchField.Input placeholder="搜索联系人" />
              <SearchField.ClearButton />
            </SearchField.Group>
          </SearchField>

          <Tabs
            className="mt-3 w-full"
            selectedKey={mode}
            onSelectionChange={(key) => setMode(key === 'cloned' ? 'cloned' : 'all')}
          >
            <Tabs.ListContainer>
              <Tabs.List aria-label="联系人范围" className="w-full *:h-8 *:flex-1 *:gap-1.5 *:text-xs">
                <Tabs.Tab id="all">
                  <Persons className="size-3.5" />
                  全部联系人
                  <Tabs.Indicator />
                </Tabs.Tab>
                <Tabs.Tab id="cloned">
                  <FaceRobot className="size-3.5" />
                  已克隆
                  <Tabs.Indicator />
                </Tabs.Tab>
              </Tabs.List>
            </Tabs.ListContainer>
          </Tabs>
        </div>

        <div
          ref={contactListRef}
          className="ct-agent-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain py-2"
          onScroll={handleContactListScroll}
        >
          {loading && listItems.length === 0 ? (
            <div className="flex h-40 items-center justify-center gap-2 text-sm text-muted">
              <CircleDashed className="size-4 animate-spin" />
              正在读取联系人...
            </div>
          ) : error ? (
            <div className="m-2 rounded-lg bg-danger-soft p-3 text-sm text-danger-soft-foreground">{error}</div>
          ) : listItems.length === 0 ? (
            <div className="flex h-40 flex-col items-center justify-center gap-2 text-center text-sm text-muted">
              <PersonPlus className="size-6" />
              <span>{mode === 'cloned' ? '还没有数字分身' : '没有匹配的联系人'}</span>
            </div>
          ) : (
            <>
              {listItems.map((item) => (
                <PersonaContactRow
                  key={item.sessionId}
                  item={item}
                  selectedSessionId={selectedSessionId}
                  onSelect={setSelectedSessionId}
                />
              ))}
              {mode === 'all' && (contactsHasMore || loadingContactsMore) && (
                <div className="flex h-14 items-center justify-center px-3 text-xs text-muted">
                  {loadingContactsMore ? (
                    <span className="inline-flex items-center gap-2">
                      <CircleDashed className="size-3.5 animate-spin" />
                      正在加载更多...
                    </span>
                  ) : (
                    <Button size="sm" variant="tertiary" onPress={loadMoreContacts}>加载更多</Button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col bg-(--bg-primary)">
        {selectedSessionId ? (
          <PersonaChatPage
            key={selectedSessionId}
            embedded
            sessionId={selectedSessionId}
            onPersonaChanged={loadPersonas}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-muted">
            <LottieView autoplay loop className="size-36" src={personaOrbUrl} />
            <div>
              <div className="text-sm font-semibold text-foreground">选择一个联系人</div>
              <div className="mt-1 text-sm">右侧会显示克隆确认和分身聊天窗口</div>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
