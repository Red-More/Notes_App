import { useCallback, useEffect, useRef, useState } from 'react'
import { IconBack } from '../../components/Icons'
import { useEdgeBack } from '../../hooks'
import { usePhysicalBack } from '../../system/backButton'
import AccountSection from './AccountSection'
import AiSection from './AiSection'
import AppearanceSection from './AppearanceSection'
import AboutSection from './AboutSection'
import EditorSection from './EditorSection'
import NotificationSection from './NotificationSection'
import StorageSection from './StorageSection'
import { SettingsOverlayContext } from './settingsOverlay'

interface Props {
  onBack: () => void
}

const QUICK_NAV = [
  { id: 'settings-account', label: '账号' },
  { id: 'settings-notifications', label: '通知' },
  { id: 'settings-appearance', label: '外观' },
  { id: 'settings-editor', label: '编辑' },
  { id: 'settings-ai', label: 'AI' },
  { id: 'settings-storage', label: '存储' },
  { id: 'settings-about', label: '关于' },
]

export default function SettingsPage({ onBack }: Props) {
  const overlayCloseRef = useRef<(() => void) | null>(null)
  const registerOverlay = useCallback((close: () => void) => {
    overlayCloseRef.current = close
    return () => {
      if (overlayCloseRef.current === close) overlayCloseRef.current = null
    }
  }, [])

  // Back gestures dismiss an open popover first; only then do they leave the
  // page, so the hardware key never skips a visible layer.
  const handleBack = useCallback(() => {
    if (overlayCloseRef.current) {
      overlayCloseRef.current()
      return
    }
    onBack()
  }, [onBack])
  useEdgeBack(handleBack)
  usePhysicalBack(handleBack)

  const scrollerRef = useRef<HTMLElement | null>(null)
  const navRef = useRef<HTMLElement | null>(null)
  const scrollFrameRef = useRef(0)
  const navSettleRef = useRef(0)
  /** Suppresses active-section updates while a programmatic jump is running. */
  const jumpLockUntilRef = useRef(0)
  /** Ignores chip-centering scroll events as if they were user gestures. */
  const programmaticNavUntilRef = useRef(0)
  const navGestureRef = useRef(false)
  const [activeId, setActiveId] = useState(QUICK_NAV[0].id)

  const jumpTo = useCallback((id: string) => {
    const target = document.getElementById(id)
    if (!target) return
    setActiveId(id)
    jumpLockUntilRef.current = performance.now() + 800
    target.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  /** Pick the last group whose top has passed under the sticky tab strip. */
  const syncActive = useCallback(() => {
    const scroller = scrollerRef.current
    if (!scroller || performance.now() < jumpLockUntilRef.current) return
    const scrollerTop = scroller.getBoundingClientRect().top
    // A few px of tolerance keeps a just-jumped group active after scroll-margin.
    const offset = (navRef.current?.offsetHeight ?? 0) + 12
    let next = QUICK_NAV[0].id
    for (const item of QUICK_NAV) {
      const section = document.getElementById(item.id)
      if (section && section.getBoundingClientRect().top - scrollerTop <= offset) {
        next = item.id
      }
    }
    // A short last group may never cross the offset; the bottom edge wins.
    if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) {
      next = QUICK_NAV[QUICK_NAV.length - 1].id
    }
    setActiveId((current) => (current === next ? current : next))
  }, [])

  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    const onScroll = () => {
      if (scrollFrameRef.current) return
      scrollFrameRef.current = requestAnimationFrame(() => {
        scrollFrameRef.current = 0
        syncActive()
      })
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    syncActive()
    return () => {
      scroller.removeEventListener('scroll', onScroll)
      if (scrollFrameRef.current) cancelAnimationFrame(scrollFrameRef.current)
      scrollFrameRef.current = 0
    }
  }, [syncActive])

  // Keep the active chip centered in the horizontal strip.
  useEffect(() => {
    const nav = navRef.current
    if (!nav) return
    const chip = nav.querySelector<HTMLElement>(`[data-section="${activeId}"]`)
    if (!chip) return
    const left = chip.offsetLeft - (nav.clientWidth - chip.offsetWidth) / 2
    programmaticNavUntilRef.current = performance.now() + 600
    nav.scrollTo({ left: Math.max(0, left), behavior: 'smooth' })
  }, [activeId])

  useEffect(
    () => () => {
      window.clearTimeout(navSettleRef.current)
      if (scrollFrameRef.current) cancelAnimationFrame(scrollFrameRef.current)
    },
    [],
  )

  /** A manual horizontal gesture overrides any chip-centering in progress. */
  const beginNavGesture = () => {
    navGestureRef.current = true
    programmaticNavUntilRef.current = 0
  }

  /** After a manual strip swipe settles, jump to the chip nearest its center. */
  const handleNavScroll = () => {
    const nav = navRef.current
    if (!nav) return
    if (performance.now() < programmaticNavUntilRef.current) return
    if (!navGestureRef.current) return
    window.clearTimeout(navSettleRef.current)
    navSettleRef.current = window.setTimeout(() => {
      navGestureRef.current = false
      const center = nav.scrollLeft + nav.clientWidth / 2
      let bestId = activeId
      let bestDistance = Number.POSITIVE_INFINITY
      nav.querySelectorAll<HTMLElement>('[data-section]').forEach((chip) => {
        const middle = chip.offsetLeft + chip.offsetWidth / 2
        const distance = Math.abs(middle - center)
        if (distance < bestDistance) {
          bestDistance = distance
          bestId = chip.dataset.section ?? activeId
        }
      })
      if (bestId !== activeId) jumpTo(bestId)
    }, 160)
  }

  return (
    <div className="editor-page settings-page">
      <header className="settings-topbar">
        <button type="button" className="settings-back" onClick={onBack} aria-label="返回">
          <IconBack size={22} />
        </button>
        <div className="settings-title-block">
          <h1 className="settings-title">设置</h1>
          <span className="settings-subtitle">更改自动保存</span>
        </div>
      </header>

      <SettingsOverlayContext.Provider value={registerOverlay}>
        <main className="settings-scroll" ref={scrollerRef}>
          <nav
            className="settings-quicknav"
            aria-label="设置分组"
            ref={navRef}
            onPointerDown={beginNavGesture}
            onWheel={beginNavGesture}
            onTouchStart={beginNavGesture}
            onScroll={handleNavScroll}
          >
            {QUICK_NAV.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`settings-quicknav-chip${activeId === item.id ? ' active' : ''}`}
                data-section={item.id}
                aria-current={activeId === item.id ? 'true' : undefined}
                onClick={() => {
                  // A tap is a jump, not a strip swipe; drop the gesture flag so
                  // the follow-up chip centering is not mistaken for navigation.
                  navGestureRef.current = false
                  jumpTo(item.id)
                }}
              >
                {item.label}
              </button>
            ))}
          </nav>

          <AccountSection />
          <NotificationSection />
          <AppearanceSection />
          <EditorSection />
          <AiSection />
          <StorageSection />
          <AboutSection />

          <footer className="settings-footer">
            <span>Notes</span>
            <span>本地优先 · 数据仅存本机</span>
          </footer>
        </main>
      </SettingsOverlayContext.Provider>
    </div>
  )
}
