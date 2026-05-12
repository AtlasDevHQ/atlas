"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { OrgSwitcher } from "@/ui/components/org-switcher";
import { UserMenu } from "@/ui/components/user-menu";
import { resolveAdminBreadcrumb } from "@/ui/components/admin/admin-nav";
import { PendingChangesPill } from "@/ui/components/admin/pending-changes-pill";

/** Org switcher anchors the breadcrumb root so workspace context heads every admin page. */
export function AdminTopBar() {
  const pathname = usePathname();
  const crumb = resolveAdminBreadcrumb(pathname);

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b bg-background px-4 transition-[height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <SidebarTrigger className="-ml-1" />
        <Separator orientation="vertical" className="mr-1 h-4" />
        <Breadcrumb className="min-w-0 flex-1">
          <BreadcrumbList className="flex-nowrap">
            <BreadcrumbItem className="shrink-0">
              <OrgSwitcher variant="inline" />
            </BreadcrumbItem>
            <BreadcrumbSeparator className="shrink-0" />
            <BreadcrumbItem className="shrink-0">
              {crumb.kind === "overview" ? (
                <BreadcrumbPage>Admin Console</BreadcrumbPage>
              ) : (
                <BreadcrumbLink asChild>
                  <Link href="/admin">Admin</Link>
                </BreadcrumbLink>
              )}
            </BreadcrumbItem>
            {/*
              Mobile (< sm): hide the intermediate section crumb so the
              page label has room next to the avatar. The "Admin" link
              still gets users back to the overview, and the active
              sidebar item supplies the section context.
            */}
            {crumb.kind === "section" && (
              <>
                <BreadcrumbSeparator className="hidden shrink-0 sm:flex" />
                <BreadcrumbItem className="hidden shrink-0 sm:flex">
                  <BreadcrumbPage>{crumb.title}</BreadcrumbPage>
                </BreadcrumbItem>
              </>
            )}
            {crumb.kind === "page" && (
              <>
                <BreadcrumbSeparator className="hidden shrink-0 sm:flex" />
                <BreadcrumbItem className="hidden shrink-0 sm:flex">
                  <span className="text-sm text-muted-foreground">{crumb.section}</span>
                </BreadcrumbItem>
                <BreadcrumbSeparator className="shrink-0" />
                <BreadcrumbItem className="min-w-0">
                  <BreadcrumbPage className="block max-w-[8rem] truncate sm:max-w-[14rem]">
                    {crumb.page}
                  </BreadcrumbPage>
                </BreadcrumbItem>
              </>
            )}
          </BreadcrumbList>
        </Breadcrumb>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <PendingChangesPill />
        <UserMenu />
      </div>
    </header>
  );
}
