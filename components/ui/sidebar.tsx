"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

function SidebarMenuSkeleton({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-menu-skeleton"
      className={cn("flex h-8 items-center gap-2 rounded-md px-2", className)}
      style={{ "--skeleton-width": "70%" } as React.CSSProperties}
      {...props}
    >
      <div className="size-4 rounded-md bg-muted" />
      <div
        className="h-4 max-w-[var(--skeleton-width)] flex-1 rounded-md bg-muted"
        style={{ width: "var(--skeleton-width)" }}
      />
    </div>
  )
}

export { SidebarMenuSkeleton }
