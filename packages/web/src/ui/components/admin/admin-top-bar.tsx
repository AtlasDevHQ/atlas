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

/**
 * Persistent top bar shared by every `/admin/*` route.
 *
 * Layout (left → right):
 *   [sidebar trigger] | [org ▾] / Admin [/ section [/ page]]      [avatar ▾]
 *
 * The org switcher is rendered as the breadcrumb root so the most
 * navigationally-significant concept (workspace) sits at the top of the page
 * tree on every admin surface — matching the chat top-right pattern.
 */
export function AdminTopBar() {
  const pathname = usePathname();
  const { section, page } = resolveAdminBreadcrumb(pathname);
  const isOverview = !section;

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b bg-background px-4 transition-[height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
      <div className="flex min-w-0 items-center gap-2">
        <SidebarTrigger className="-ml-1" />
        <Separator orientation="vertical" className="mr-1 h-4" />
        <Breadcrumb>
          <BreadcrumbList className="flex-nowrap">
            <BreadcrumbItem>
              <OrgSwitcher variant="inline" />
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              {isOverview ? (
                <BreadcrumbPage>Admin Console</BreadcrumbPage>
              ) : (
                <BreadcrumbLink asChild>
                  <Link href="/admin">Admin</Link>
                </BreadcrumbLink>
              )}
            </BreadcrumbItem>
            {section && (
              <>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  {page ? (
                    <span className="text-sm text-muted-foreground">{section}</span>
                  ) : (
                    <BreadcrumbPage>{section}</BreadcrumbPage>
                  )}
                </BreadcrumbItem>
              </>
            )}
            {page && (
              <>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <BreadcrumbPage className="max-w-[14rem] truncate">{page}</BreadcrumbPage>
                </BreadcrumbItem>
              </>
            )}
          </BreadcrumbList>
        </Breadcrumb>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <UserMenu />
      </div>
    </header>
  );
}
