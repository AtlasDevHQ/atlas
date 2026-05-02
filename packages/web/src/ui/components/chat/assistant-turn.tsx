import * as React from "react";

import { cn } from "@/lib/utils";

/** Visual gutter anchoring an assistant's response to its prompting question.
 *  Used by the chat surface and notebook query cells. */
export function AssistantTurn({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("border-l-2 border-primary/40 pl-4", className)}
      {...props}
    />
  );
}
