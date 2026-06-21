---
layout: home

hero:
  name: zorb
  text: Declarative local workflow runner
  tagline: Define your project tasks once in zorb.yml, run them anywhere.
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: Workflow reference
      link: /reference/workflow
    - theme: alt
      text: GitHub
      link: https://github.com/zorb-run/zorb-cli

features:
  - title: One file, every task
    details: |
      Replace ad-hoc shell scripts and Makefiles with a single zorb.yml.
      Tasks, inputs, env, and step composition all in YAML.
  - title: Shell, Docker, and code actions
    details: |
      Run shell commands directly, inside Docker containers, or invoke
      JavaScript, TypeScript, or Python actions — all in the same workflow.
  - title: Familiar by design
    details: |
      Borrows expression syntax, inputs, and outputs from GitHub Actions
      so it feels obvious from the first read.
  - title: Single binary
    details: |
      Distributed as a self-contained binary via NPM or Homebrew —
      no Node version juggling, no global toolchain.
---
