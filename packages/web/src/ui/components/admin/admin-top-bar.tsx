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

/** Org switcher anchors the breadcrumb root so workspace context heads every admin page. */
export function AdminTopBar() {
  const pathname = usePathname();
  const crumb = resolveAdminBreadcrumb(pathname);

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
              {crumb.section ? (
                <BreadcrumbLink asChild>
                  <Link href="/admin">Admin</Link>
                </BreadcrumbLink>
              ) : (
                <BreadcrumbPage>Admin Console</BreadcrumbPage>
              )}
            </BreadcrumbItem>
            {crumb.section && (
              <>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <span className="text-sm text-muted-foreground">{crumb.section}</span>
                </BreadcrumbItem>
              </>
            )}
            {crumb.page && (
              <>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <BreadcrumbPage className="max-w-[14rem] truncate">{crumb.page}</BreadcrumbPage>
                </BreadcrumbItem>
              </>
            )}
          </BreadcrumbList>
        </Breadcrumb>
      </div>

      <UserMenu />
    </header>
  );
}
