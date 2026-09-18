import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'
import tapflowLight from './theme/tapflow-light.json'
import tapflowDark from './theme/tapflow-dark.json'
import { emitAgentArtifacts } from './agent-artifacts.mjs'

// The canonical origin, written once.
//
// `tapflow.dev` answers 307 to `www.tapflow.dev` — that is the Vercel domain setting, and the
// user-facing docs (both READMEs, the Docker Hub overview, the dashboard's sidebar) already link
// to `www`. This file used to spell the apex in five places, which put a redirect in front of
// every one of the sitemap's 47 URLs and every link in `llms.txt`. Repeating the string is what
// let the two drift, so it is a constant now.
const SITE = 'https://www.tapflow.dev'

// VitePress(mdit-vue) 기본 slugify는 NFKD 정규화라 한글 음절을 자모 분리(NFD) 형태의 헤딩 id로 만든다.
// 브라우저 URL hash는 NFC라 바이트가 어긋나 비ASCII 헤딩으로 스크롤이 안 된다.
// mdit-vue와 동일한 특수문자·_숫자 prefix 처리에 정규화만 NFC로 바꿔 id를 완성형으로 만든다.
function nfcSlugify(str: string): string {
  return str
    .normalize('NFC')
    .replace(/[\s~`!@#$%^&*()\-_+=[\]{}|\\;:"'“”‘’<>,.?/]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^(\d)/, '_$1')
    .toLowerCase()
}

const enSidebar = [
  {
    text: 'Getting Started',
    items: [
      { text: 'Introduction', link: '/guide/introduction' },
      { text: 'Requirements', link: '/guide/requirements' },
      { text: 'Quick Start', link: '/guide/getting-started' },
    ],
  },
  {
    text: 'Setup',
    items: [
      { text: 'Environment Setup', link: '/guide/environment-setup' },
      { text: 'Configuring tapflow', link: '/guide/configure' },
      { text: 'Self-Hosting the Relay', link: '/guide/self-hosting' },
      { text: 'Agent Setup', link: '/guide/agent' },
      { text: 'Scaling Mac Resources', link: '/guide/scaling' },
    ],
  },
  {
    text: 'Distribution',
    items: [
      { text: 'Uploading Builds', link: '/guide/upload-builds' },
      { text: 'Build Distribution', link: '/guide/build-distribution' },
      { text: 'Webhooks', link: '/guide/build-status-webhooks' },
    ],
  },
  {
    text: 'Dashboard',
    items: [
      { text: 'First-time Setup', link: '/dashboard/setup' },
      { text: 'Dashboard Overview', link: '/dashboard/overview' },
    ],
  },
  {
    text: 'AI Automation',
    items: [
      { text: 'MCP Server', link: '/guide/mcp-server' },
      { text: 'Flow Reference', link: '/guide/writing-flows' },
      { text: 'MCP in CI/CD', link: '/guide/mcp-ci' },
    ],
  },
  {
    text: 'Reference',
    items: [
      { text: 'CLI Reference', link: '/reference/cli' },
      { text: 'Configuration', link: '/reference/configuration' },
      { text: 'Streaming Quality', link: '/guide/streaming' },
      { text: 'Audio', link: '/guide/audio' },
      { text: 'Network Control', link: '/guide/network-control' },
      { text: 'REST API', link: '/reference/api' },
      { text: 'Performance & Latency', link: '/reference/performance' },
      { text: 'Security & Privacy', link: '/reference/security' },
      { text: 'Sustainability', link: '/reference/sustainability' },
    ],
  },
  {
    text: 'Troubleshooting',
    items: [
      { text: 'Troubleshooting', link: '/guide/troubleshooting' },
    ],
  },
  {
    text: 'Contributing',
    items: [
      { text: 'Contributing Guide', link: '/guide/contributing' },
    ],
  },
]

const koSidebar = [
  {
    text: '시작하기',
    items: [
      { text: '소개', link: '/ko/guide/introduction' },
      { text: '시스템 요구사항', link: '/ko/guide/requirements' },
      { text: '빠른 시작', link: '/ko/guide/getting-started' },
    ],
  },
  {
    text: '설정',
    items: [
      { text: '환경 준비', link: '/ko/guide/environment-setup' },
      { text: 'tapflow 설정', link: '/ko/guide/configure' },
      { text: '릴레이 배포', link: '/ko/guide/self-hosting' },
      { text: '에이전트 설정', link: '/ko/guide/agent' },
      { text: 'Mac 리소스 확장', link: '/ko/guide/scaling' },
    ],
  },
  {
    text: '빌드 배포',
    items: [
      { text: '빌드 업로드', link: '/ko/guide/upload-builds' },
      { text: '빌드 배포', link: '/ko/guide/build-distribution' },
      { text: '웹훅', link: '/ko/guide/build-status-webhooks' },
    ],
  },
  {
    text: '대시보드',
    items: [
      { text: '최초 설정', link: '/ko/dashboard/setup' },
      { text: '대시보드 개요', link: '/ko/dashboard/overview' },
    ],
  },
  {
    text: 'AI 자동화',
    items: [
      { text: 'MCP 서버', link: '/ko/guide/mcp-server' },
      { text: '플로우 레퍼런스', link: '/ko/guide/writing-flows' },
      { text: 'CI/CD에서 MCP 활용', link: '/ko/guide/mcp-ci' },
    ],
  },
  {
    text: '레퍼런스',
    items: [
      { text: 'CLI 레퍼런스', link: '/ko/reference/cli' },
      { text: '설정 파일', link: '/ko/reference/configuration' },
      { text: '스트림 품질', link: '/ko/guide/streaming' },
      { text: '오디오', link: '/ko/guide/audio' },
      { text: '네트워크 제어', link: '/ko/guide/network-control' },
      { text: 'REST API', link: '/ko/reference/api' },
      { text: '성능과 지연', link: '/ko/reference/performance' },
      { text: '보안 및 개인정보', link: '/ko/reference/security' },
      { text: '지속가능성', link: '/ko/reference/sustainability' },
    ],
  },
  {
    text: '트러블슈팅',
    items: [
      { text: '문제 해결', link: '/ko/guide/troubleshooting' },
    ],
  },
  {
    text: '기여',
    items: [
      { text: '기여 가이드', link: '/ko/guide/contributing' },
    ],
  },
]

export default withMermaid(defineConfig({
  title: 'tapflow',
  description: 'Self-hosted iOS/Android simulator streaming for the whole team',
  cleanUrls: true,

  // `docs/AGENTS.md` and `docs/CLAUDE.md` are contributor rules for working on this VitePress site.
  // Without this they built into the public site and took the first two rows of the sitemap, so a
  // crawler or an agent surveying tapflow's documentation met our internal writing conventions
  // before it met the product. The files stay where they are — INDEX.md links them.
  //
  // `**/` because a bare `AGENTS.md` matches the srcDir root only, so a second one added under a
  // locale would publish itself.
  srcExclude: ['**/AGENTS.md', '**/CLAUDE.md'],

  // Ship the source markdown beside the HTML, and the English prose as one file. See
  // `agent-artifacts.mjs` for what an agent gets without it.
  async buildEnd(siteConfig) {
    const { copied, bundled } = await emitAgentArtifacts({
      srcDir: siteConfig.srcDir,
      outDir: siteConfig.outDir,
      pages: siteConfig.pages,
      hostname: SITE,
    })
    siteConfig.logger.info(
      `agent artifacts: ${copied.length} .md copied, ${bundled.length} pages in llms-full.txt`,
    )
  },

  sitemap: {
    hostname: SITE,
  },

  locales: {
    root: {
      label: 'English',
      lang: 'en-US',
      themeConfig: {
        nav: [
          { text: 'Guide', link: '/guide/introduction', activeMatch: '^/(guide|dashboard)' },
          { text: 'Reference', link: '/reference/cli', activeMatch: '^/reference' },
          { text: 'Changelog', link: 'https://github.com/jo-duchan/tapflow/blob/main/CHANGELOG.md' },
        ],
        sidebar: enSidebar,
      },
    },
    ko: {
      label: '한국어',
      lang: 'ko-KR',
      themeConfig: {
        nav: [
          { text: '가이드', link: '/ko/guide/introduction', activeMatch: '^/ko/(guide|dashboard)' },
          { text: '레퍼런스', link: '/ko/reference/cli', activeMatch: '^/ko/reference' },
          { text: '변경 기록', link: 'https://github.com/jo-duchan/tapflow/blob/main/CHANGELOG.md' },
        ],
        sidebar: koSidebar,
      },
    },
  },

  head: [
    ['link', { rel: 'icon', href: '/favicon.ico', sizes: '32x32' }],
    ['link', { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.googleapis.com' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' }],
    [
      'link',
      {
        href: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400&display=swap',
        rel: 'stylesheet',
      },
    ],
    [
      'script',
      { type: 'application/ld+json' },
      JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'SoftwareApplication',
        name: 'tapflow',
        applicationCategory: 'DeveloperApplication',
        operatingSystem: 'macOS, Linux',
        description:
          'Open-source, self-hosted alternative to Appetize and BrowserStack App Live. Run iOS simulators and Android emulators in the browser for your whole team — app binaries never leave your network.',
        url: SITE,
        license: 'https://opensource.org/licenses/MIT',
        isAccessibleForFree: true,
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
        sameAs: ['https://github.com/jo-duchan/tapflow'],
      }),
    ],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:url', content: SITE }],
    ['meta', { property: 'og:title', content: 'tapflow — Self-hosted simulator streaming for your whole team' }],
    [
      'meta',
      {
        property: 'og:description',
        content:
          'Open-source, self-hosted alternative to Appetize and BrowserStack App Live. Run iOS & Android simulators in the browser — no data leaving your network.',
      },
    ],
    ['meta', { property: 'og:image', content: `${SITE}/demo-thumbnail.png` }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:title', content: 'tapflow — Self-hosted simulator streaming for your whole team' }],
    [
      'meta',
      {
        name: 'twitter:description',
        content:
          'Open-source, self-hosted alternative to Appetize and BrowserStack App Live. Run iOS & Android simulators in the browser — no data leaving your network.',
      },
    ],
    ['meta', { name: 'twitter:image', content: `${SITE}/demo-thumbnail.png` }],
  ],

  markdown: {
    theme: { light: tapflowLight as any, dark: tapflowDark as any },
    anchor: { slugify: nfcSlugify },
  },

  vite: {
    optimizeDeps: {
      include: ['mermaid'],
    },
  },

  themeConfig: {
    logo: { light: '/logo.svg', dark: '/logo-dark.svg' },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/jo-duchan/tapflow' },
    ],
    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2026-present tapflow contributors',
    },
    search: {
      provider: 'local',
    },
  },
}))
