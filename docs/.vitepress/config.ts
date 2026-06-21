import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'zorb',
  description: 'Declarative local workflow runner.',
  lastUpdated: true,
  cleanUrls: true,
  head: [['link', { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }]],
  // zorb's expression syntax (`${{ ... }}`) clashes with Vue's `{{ }}` interpolation
  // inside inline code spans. Wrap any such span in v-pre so Vue leaves it alone.
  markdown: {
    config: (md) => {
      const escapeHtml = md.utils.escapeHtml;
      md.renderer.rules.code_inline = (tokens, idx) => {
        const content = tokens[idx]!.content;
        const v = content.includes('{{') ? ' v-pre' : '';
        return `<code${v}>${escapeHtml(content)}</code>`;
      };
    },
  },
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/getting-started', activeMatch: '/guide/' },
      { text: 'Reference', link: '/reference/workflow', activeMatch: '/reference/' },
      { text: 'GitHub', link: 'https://github.com/zorb-run/zorb-cli' },
    ],
    sidebar: {
      '/guide/': [
        {
          text: 'Guide',
          items: [
            { text: 'Getting started', link: '/guide/getting-started' },
            { text: 'Creating workflows', link: '/guide/creating-workflows' },
            { text: 'Creating shell steps', link: '/guide/creating-shell-steps' },
            { text: 'Creating code steps', link: '/guide/creating-code-steps' },
            { text: 'Writing actions', link: '/guide/actions' },
          ],
        },
      ],
      '/reference/': [
        {
          text: 'Reference',
          items: [
            { text: 'Workflow format', link: '/reference/workflow' },
            { text: 'Expressions', link: '/reference/expressions' },
          ],
        },
      ],
    },
    socialLinks: [{ icon: 'github', link: 'https://github.com/zorb-run/zorb-cli' }],
    editLink: {
      pattern: 'https://github.com/zorb-run/zorb-cli/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },
    footer: {
      message: 'MIT licensed',
      copyright: 'Copyright © zorb-run',
    },
    search: {
      provider: 'local',
    },
  },
});
