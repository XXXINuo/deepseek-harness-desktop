import type { RefObject } from 'react'
import { useWatch } from '@reause/core'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { type } from '@tauri-apps/plugin-os'
import { useEffect, useRef } from 'react'

interface DeviceMousePosition {
  x: number
  y: number
}

interface PetInputRect {
  x: number
  y: number
  width: number
  height: number
}

interface RustPetStatus {
  enabled?: boolean
  visible?: boolean | null
}

export function useOmitIgnoreCursorEvents(elementRef: RefObject<HTMLElement | null>, dragging = false): void {
  const draggingRef = useRef(dragging)
  draggingRef.current = dragging
  const refreshRef = useRef<() => void>(() => {})

  useWatch(dragging, () => refreshRef.current())

  // keep:effect 原生窗口订阅必须随挂载注册、卸载注销。
  useEffect(() => {
    const appWindow = getCurrentWindow()
    if (appWindow.label !== 'pet')
      return
    // Linux 走输入形状而非整窗穿透：XWayland 下穿透后收不到全局鼠标流，桌宠再也点不到（issue #649）。
    const inputRegion = type() === 'linux'
    let appliedRegion: PetInputRect | undefined
    let regionFrame: number | undefined
    let disposed = false
    let appliedIgnore: boolean | undefined = false
    let desiredIgnore = false
    let pendingIgnore = false
    let windowVisible: boolean | undefined
    let visibilityRevision = 0
    let windowPosition: DeviceMousePosition | undefined
    let geometryRevision = 0
    let lastCursor: DeviceMousePosition | undefined
    const unlisteners: Array<() => void> = []

    function setIgnoreCursorEvents(ignore: boolean): void {
      desiredIgnore = ignore && windowVisible !== false
      if (disposed || pendingIgnore || desiredIgnore === appliedIgnore)
        return
      const requested = desiredIgnore
      pendingIgnore = true
      void invoke<boolean>('set_pet_ignore_cursor_events', { ignore: requested }).then((applied) => {
        appliedIgnore = applied
      }).catch((error) => {
        appliedIgnore = undefined
        console.warn('[pet] PET_INPUT_UPDATE_FAILED:', error)
      }).finally(() => {
        pendingIgnore = false
        if (desiredIgnore !== requested)
          setIgnoreCursorEvents(desiredIgnore)
      })
    }

    function applyInputRegion(): void {
      regionFrame = undefined
      const element = elementRef.current
      if (disposed || element === null)
        return
      const { x, y, width, height } = element.getBoundingClientRect()
      const rect = { x, y, width, height }
      if (appliedRegion !== undefined && appliedRegion.x === x && appliedRegion.y === y && appliedRegion.width === width && appliedRegion.height === height)
        return
      appliedRegion = rect
      void invoke('set_pet_input_region', { rect }).catch((error) => {
        appliedRegion = undefined
        console.warn('[pet] PET_INPUT_UPDATE_FAILED:', error)
      })
    }

    function scheduleInputRegion(): void {
      if (regionFrame === undefined)
        regionFrame = requestAnimationFrame(applyInputRegion)
    }

    function handleVisibility(visible: boolean): void {
      windowVisible = visible
      if (inputRegion) {
        scheduleInputRegion()
        return
      }
      if (visible)
        refreshFromState()
      else
        setIgnoreCursorEvents(false)
    }

    async function refreshWindowPosition(): Promise<void> {
      const revision = ++geometryRevision
      try {
        const position = await appWindow.innerPosition()
        if (!disposed && revision === geometryRevision) {
          windowPosition = position
          refreshFromState()
        }
      }
      catch (error) {
        if (!disposed)
          console.warn('[pet] PET_INPUT_POSITION_FAILED:', error)
      }
    }

    function isCursorInElement(x: number, y: number): boolean | undefined {
      const element = elementRef.current
      if (element === null)
        return false
      if (windowPosition === undefined)
        return undefined
      const rect = element.getBoundingClientRect()
      const scale = globalThis.devicePixelRatio || 1
      const left = windowPosition.x + rect.left * scale
      const top = windowPosition.y + rect.top * scale
      return x >= left && x <= left + rect.width * scale && y >= top && y <= top + rect.height * scale
    }

    function refreshFromState(): void {
      if (disposed)
        return
      if (inputRegion) {
        scheduleInputRegion()
        return
      }
      if (draggingRef.current) {
        setIgnoreCursorEvents(false)
        return
      }
      // 等首个设备样本再切穿透，避免尚未 realize 的 GTK 窗口崩溃。
      if (lastCursor === undefined)
        return
      const inElement = isCursorInElement(lastCursor.x, lastCursor.y)
      if (inElement !== undefined)
        setIgnoreCursorEvents(!inElement)
    }
    refreshRef.current = refreshFromState

    const regionObserver = inputRegion ? new MutationObserver(scheduleInputRegion) : undefined
    regionObserver?.observe(document.body, { childList: true, subtree: true, attributes: true })
    void refreshWindowPosition()
    const initialVisibilityRevision = visibilityRevision
    void appWindow.isVisible().then((visible) => {
      if (!disposed && visibilityRevision === initialVisibilityRevision)
        handleVisibility(visible)
    }).catch(error => console.warn('[pet] PET_INPUT_VISIBILITY_FAILED:', error))

    const subscriptions = [
      // Moved 事件自带新位置（桌宠窗口无装饰，outer == inner）：直接采用，拖动期间
      // 每秒数百个 Moved 不再各自触发一次 innerPosition() IPC 往返。moved 同时推进
      // geometryRevision：让更早发起、此刻还在途的 innerPosition() 查询在落回时
      // 因 revision 失配被丢弃，不致用旧位置覆盖 moved 给的新位置。
      appWindow.onMoved(({ payload }) => {
        geometryRevision++
        windowPosition = payload
        refreshFromState()
      }),
      appWindow.onResized(() => { void refreshWindowPosition() }),
      listen<RustPetStatus>('pet://status', ({ payload }) => {
        visibilityRevision++
        handleVisibility(payload.enabled !== false && payload.visible !== false)
      }),
      listen<DeviceMousePosition>('device-mouse-move', ({ payload }) => {
        lastCursor = payload
        if (windowPosition === undefined)
          void refreshWindowPosition()
        refreshFromState()
      }),
    ]

    void Promise.allSettled(subscriptions.map(async (subscription) => {
      const unlisten = await subscription
      if (disposed)
        unlisten()
      else
        unlisteners.push(unlisten)
    })).then((results) => {
      for (const result of results) {
        if (result.status === 'rejected')
          console.warn('[pet] PET_INPUT_LISTEN_FAILED:', result.reason)
      }
      if (!disposed)
        return invoke('start_pet_mouse_stream')
    }).catch(error => console.warn('[pet] PET_INPUT_STREAM_FAILED:', error))

    return () => {
      disposed = true
      regionObserver?.disconnect()
      if (regionFrame !== undefined)
        cancelAnimationFrame(regionFrame)
      refreshRef.current = () => {}
      geometryRevision++
      for (const unlisten of unlisteners)
        unlisten()
    }
  }, [elementRef])
}
