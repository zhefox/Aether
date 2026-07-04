import { describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h } from 'vue'

import AntigravityQuotaDialog from '@/features/providers/components/AntigravityQuotaDialog.vue'
import type { UpstreamMetadata } from '@/api/endpoints/types'

vi.mock('@/components/ui', async () => {
  const { defineComponent, h } = await import('vue')

  const passthrough = (name: string) => defineComponent({
    name,
    setup(_, { slots }) {
      return () => h('div', [
        slots.headerActions?.(),
        slots.default?.(),
        slots.footer?.(),
      ])
    },
  })

  return {
    Dialog: passthrough('DialogStub'),
    DropdownMenu: passthrough('DropdownMenuStub'),
    DropdownMenuTrigger: passthrough('DropdownMenuTriggerStub'),
    DropdownMenuContent: passthrough('DropdownMenuContentStub'),
    DropdownMenuItem: defineComponent({
      name: 'DropdownMenuItemStub',
      emits: ['select'],
      setup(_, { emit, slots }) {
        return () => h('button', { type: 'button', onClick: () => emit('select') }, slots.default?.())
      },
    }),
  }
})

vi.mock('@/components/ui/button.vue', async () => {
  const { defineComponent, h } = await import('vue')

  return {
    default: defineComponent({
      name: 'ButtonStub',
      setup(_, { attrs, slots }) {
        return () => h('button', { ...attrs, type: 'button' }, slots.default?.())
      },
    }),
  }
})

vi.mock('lucide-vue-next', async () => {
  const { defineComponent, h } = await import('vue')
  const Icon = defineComponent({
    name: 'IconStub',
    setup() {
      return () => h('span')
    },
  })

  return {
    BarChart3: Icon,
    Loader2: Icon,
    Play: Icon,
  }
})

vi.mock('@/api/endpoints/providers', () => ({
  testModel: vi.fn(),
}))

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({
    error: vi.fn(),
    success: vi.fn(),
  }),
}))

vi.mock('@/utils/errorParser', () => ({
  parseApiError: (value: unknown) => String(value),
}))

function mount(metadata: UpstreamMetadata) {
  const root = document.createElement('div')
  document.body.appendChild(root)

  const app = createApp(defineComponent({
    setup() {
      return () => h(AntigravityQuotaDialog, {
        open: true,
        metadata,
        keyName: 'Key-1',
      })
    },
  }))
  app.mount(root)

  return {
    root,
    unmount: () => {
      app.unmount()
      root.remove()
    },
  }
}

describe('AntigravityQuotaDialog', () => {
  it('renders model display names without losing raw model identifiers', () => {
    const { root, unmount } = mount({
      antigravity: {
        quota_by_model: {
          'RateLimitResetCredit_05cbb6eeeb9c81918e011d8300f9ebfb': {
            display_name: 'RateLimitResetCredit_05cbb6eeeb9c81918e011d8300f9ebfb',
            remaining_fraction: 0.25,
            used_percent: 75,
          },
        },
      },
    })

    expect(root.textContent).toContain('Key-1')
    expect(root.textContent).toContain('RateLimitResetCredit_05cbb6eeeb9c81918e011d8300f9ebfb')
    expect(root.textContent).toContain('25.0%')

    unmount()
  })
})
