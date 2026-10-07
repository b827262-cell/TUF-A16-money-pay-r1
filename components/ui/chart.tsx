"use client"

import * as React from "react"

type ChartConfigItem = {
  label?: React.ReactNode
  color?: string
  theme?: {
    light?: string
    dark?: string
  }
}

export type ChartConfig = Record<string, ChartConfigItem>

function chartVariables(config: ChartConfig, theme: "light" | "dark") {
  return Object.entries(config)
    .map(([key, item]) => {
      const color = item.theme?.[theme] ?? item.color
      return color ? `  --color-${key}: ${color};` : null
    })
    .filter(Boolean)
    .join("\n")
}

function ChartStyle({ id, config }: { id: string; config: ChartConfig }) {
  const light = chartVariables(config, "light")
  const dark = chartVariables(config, "dark")

  if (!light && !dark) return null

  const selector = `[data-chart=${id}]`
  const css = [
    light ? `${selector} {\n${light}\n}` : "",
    dark
      ? `@media (prefers-color-scheme: dark) {\n  ${selector} {\n${dark
          .split("\n")
          .map((line) => `  ${line}`)
          .join("\n")}\n  }\n}`
      : "",
  ]
    .filter(Boolean)
    .join("\n")

  return <style dangerouslySetInnerHTML={{ __html: css }} />
}

export { ChartStyle }
