import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { act, cleanup } from '@testing-library/react'

// Drain pending React scheduler work after each test. Some hooks (e.g.
// useThemeColors) schedule state updates from async DOM events (MutationObserver
// / storage); without a flush, react-dom's performWorkUntilDeadline can fire
// after jsdom teardown and throw "window is not defined".
afterEach(async () => {
    cleanup()
    await act(async () => {})
})

function installMemoryLocalStorage(): void {
    const store = new Map<string, string>()
    const memoryLocalStorage: Storage = {
        get length() {
            return store.size
        },
        clear() {
            store.clear()
        },
        getItem(key: string) {
            return store.get(key) ?? null
        },
        key(index: number) {
            return Array.from(store.keys())[index] ?? null
        },
        removeItem(key: string) {
            store.delete(key)
        },
        setItem(key: string, value: string) {
            store.set(key, String(value))
        }
    }

    Object.defineProperty(globalThis, 'localStorage', {
        value: memoryLocalStorage,
        configurable: true
    })
    Object.defineProperty(window, 'localStorage', {
        value: memoryLocalStorage,
        configurable: true
    })
}

try {
    const storage = globalThis.localStorage
    if (
        typeof storage?.getItem !== 'function'
        || typeof storage.setItem !== 'function'
        || typeof storage.removeItem !== 'function'
        || typeof storage.clear !== 'function'
    ) {
        installMemoryLocalStorage()
    }
} catch {
    installMemoryLocalStorage()
}

if (!('IntersectionObserver' in globalThis)) {
    class MockIntersectionObserver implements IntersectionObserver {
        readonly root = null
        readonly rootMargin = ''
        readonly thresholds = []

        disconnect() {}
        observe() {}
        takeRecords(): IntersectionObserverEntry[] { return [] }
        unobserve() {}
    }

    Object.defineProperty(globalThis, 'IntersectionObserver', {
        value: MockIntersectionObserver,
        configurable: true
    })
    Object.defineProperty(window, 'IntersectionObserver', {
        value: MockIntersectionObserver,
        configurable: true
    })
}

if (typeof window.matchMedia !== 'function') {
    Object.defineProperty(window, 'matchMedia', {
        writable: true,
        configurable: true,
        value: (query: string) => ({
            matches: false,
            media: query,
            onchange: null,
            addListener() {},
            removeListener() {},
            addEventListener() {},
            removeEventListener() {},
            dispatchEvent() { return false },
        }),
    })
}
