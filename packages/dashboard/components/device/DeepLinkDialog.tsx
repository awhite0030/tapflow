'use client';

import { useState, useEffect, useRef } from 'react';
import { Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Takes the url rather than a `send`, because the caller has to mint and record the correlation id
   *  that lets the viewer tell this deeplink's reply from someone else's on the same session. */
  openUrl: (url: string) => void;
}

export function DeepLinkDialog({ open, onOpenChange, openUrl }: Props) {
  const [url, setUrl] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 0);
    } else {
      setUrl('');
    }
  }, [open]);

  const handleSubmit = () => {
    if (!url.trim()) return;
    openUrl(url.trim());
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="w-[500px] max-w-[500px] h-[52px] !rounded-[18px] p-[10px] border border-border bg-background shadow-lg overflow-hidden [&>button]:hidden"
        aria-describedby={undefined}
      >
        <DialogTitle className="sr-only">Open Deeplink</DialogTitle>
        <div className="flex items-center gap-3">
          <div className="flex-1 h-[32px] flex items-center gap-2 pl-[4px] pb-[1px]">
            <Search className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden="true" />
            <input
              ref={inputRef}
              // The dialog's own title is `sr-only` and not associated with the field, and a placeholder
              // is not a label — it disappears on the first keystroke. Without this the field is
              // announced as an unnamed edit box.
              aria-label="Deeplink URL"
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground min-w-0"
              placeholder="myapp://home..."
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSubmit();
              }}
            />
          </div>
          <Button
            size="sm"
            disabled={!url.trim()}
            onClick={handleSubmit}
            className="shrink-0 rounded-xl h-8 px-4"
          >
            Open
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
