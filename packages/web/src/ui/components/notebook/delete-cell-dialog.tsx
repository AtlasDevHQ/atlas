"use client";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface DeleteCellDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cellNumber: number;
  isTextCell?: boolean;
  onConfirm: () => void;
}

export function DeleteCellDialog({ open, onOpenChange, cellNumber, isTextCell, onConfirm }: DeleteCellDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Delete {isTextCell ? "Text Cell" : `Cell ${cellNumber}`}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {isTextCell
              ? "This will remove this text cell. This action cannot be undone."
              : "This will remove this cell and all subsequent query cells. Text cells are preserved. This action cannot be undone."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className="bg-red-600 text-white hover:bg-red-700"
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
