// UploadDropZone — drag-and-drop + click-to-open file picker for the
// Excel-import flow (Milestone 1.11 S3).
//
// Per CLAUDE.md non-negotiable #11 ("Excel imports are sanitized") + the
// SECURITY.md §2.11 close-outs:
//
//   - File-type guard (T-X44): only .xlsx and .xlsm accepted. .xls is
//     binary 97-2003 and out of scope for 1.11; .csv has no schema
//     boundary; both are rejected with a clear message.
//   - Size guard (T-X9): 10 MB cap surfaced BEFORE the file is read into
//     memory. The worker has a second 10 MB guard (MAX_FILE_BYTES) as the
//     structural backstop.
//   - Constraint copy front-and-center per ADR §3.7: "parsing happens on
//     this device — the file never leaves your browser."
//
// The component is a controlled file selector: it does NOT itself read
// the file. The caller (NewExcelImportView) reads + hashes + parses;
// this component's job is to surface the affordance, validate the
// type/size, and call onFileChosen with the validated File.

import { useCallback, useRef, useState, type DragEvent, type ChangeEvent } from 'react';
import { FileSpreadsheet, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const ACCEPTED_EXTENSIONS = ['.xlsx', '.xlsm'] as const;

export type UploadRejectionReason = 'wrong_extension' | 'too_large' | 'empty' | 'too_many_files';

export interface UploadRejection {
  readonly reason: UploadRejectionReason;
  readonly filename: string | null;
  readonly bytes: number | null;
}

export interface UploadDropZoneProps {
  readonly onFileChosen: (file: File) => void;
  /** Called when the rep drops an unsupported file. The view renders a
   * small error banner near the drop zone. */
  readonly onRejected: (rejection: UploadRejection) => void;
  /** When true, the drop zone is rendered but interactions are
   * disabled (e.g. while a previous parse is still running). */
  readonly disabled?: boolean;
  /** Optional extra classes (e.g. mt-4) for the wrapping element. */
  readonly className?: string;
  /** When true, render a compact "Try a different file" CTA instead of
   * the full drop zone. Used by the parse-error view to swap files. */
  readonly compact?: boolean;
}

export function UploadDropZone({
  onFileChosen,
  onRejected,
  disabled,
  className,
  compact,
}: UploadDropZoneProps): JSX.Element {
  const [isHovering, setHovering] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const handleFile = useCallback(
    (file: File | null) => {
      if (!file) {
        onRejected({ reason: 'empty', filename: null, bytes: null });
        return;
      }
      // Extension guard. We accept by extension rather than MIME because
      // browsers report inconsistent MIME for xlsx/xlsm (some report
      // application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,
      // others application/zip, some empty). The worker's SheetJS parse
      // catches any wire-shape mismatch downstream.
      const lower = file.name.toLowerCase();
      const ok = ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
      if (!ok) {
        onRejected({ reason: 'wrong_extension', filename: file.name, bytes: file.size });
        return;
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        onRejected({ reason: 'too_large', filename: file.name, bytes: file.size });
        return;
      }
      if (file.size === 0) {
        onRejected({ reason: 'empty', filename: file.name, bytes: 0 });
        return;
      }
      onFileChosen(file);
    },
    [onFileChosen, onRejected],
  );

  const onInputChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const list = e.target.files;
      if (!list || list.length === 0) return;
      if (list.length > 1) {
        onRejected({ reason: 'too_many_files', filename: list[0]?.name ?? null, bytes: null });
        // Reset so the same files can be re-selected if the rep retries.
        e.target.value = '';
        return;
      }
      handleFile(list[0]!);
      // Reset the input so re-selecting the same file fires onChange.
      e.target.value = '';
    },
    [handleFile, onRejected],
  );

  const onDrop = useCallback(
    (e: DragEvent<HTMLLabelElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setHovering(false);
      if (disabled) return;
      const dt = e.dataTransfer;
      if (!dt) return;
      if (dt.files.length === 0) return;
      if (dt.files.length > 1) {
        onRejected({ reason: 'too_many_files', filename: dt.files[0]?.name ?? null, bytes: null });
        return;
      }
      handleFile(dt.files[0]!);
    },
    [disabled, handleFile, onRejected],
  );

  const onDragOver = useCallback((e: DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setHovering(true);
  }, []);

  const onDragLeave = useCallback((e: DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setHovering(false);
  }, []);

  if (compact) {
    return (
      <div className={cn('flex flex-wrap items-center gap-2', className)}>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
        >
          <Upload className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
          Try a different file
        </Button>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED_EXTENSIONS.join(',')}
          className="sr-only"
          onChange={onInputChange}
          disabled={disabled}
          aria-label="Upload Excel workbook"
        />
      </div>
    );
  }

  return (
    <label
      htmlFor="excel-import-file-input"
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      className={cn(
        'group flex cursor-pointer flex-col items-center justify-center rounded-md border-2 border-dashed bg-card p-6 text-center transition-colors',
        'focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2',
        isHovering ? 'border-primary bg-primary/5' : 'border-border',
        disabled ? 'cursor-not-allowed opacity-60' : 'hover:bg-secondary/40',
        className,
      )}
    >
      <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-secondary">
        <FileSpreadsheet
          className="h-6 w-6 text-muted-foreground"
          strokeWidth={1.75}
          aria-hidden="true"
        />
      </div>
      <div className="mt-3 text-sm font-medium text-foreground">
        Drop your workbook or tap to choose
      </div>
      <p className="mt-1 max-w-sm text-xs text-muted-foreground">
        Up to 10 MB. .xlsx or .xlsm only. Parsing happens on this device — the file never leaves
        your browser.
      </p>
      <input
        id="excel-import-file-input"
        ref={inputRef}
        type="file"
        accept={ACCEPTED_EXTENSIONS.join(',')}
        className="sr-only"
        onChange={onInputChange}
        disabled={disabled}
        aria-label="Upload Excel workbook"
      />
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="mt-3"
        disabled={disabled}
        onClick={(e) => {
          e.preventDefault();
          inputRef.current?.click();
        }}
      >
        <Upload className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
        Choose file
      </Button>
    </label>
  );
}

/**
 * Map an upload-rejection shape to a human-readable copy block. The view
 * renders this near the drop zone in a small amber banner per the
 * "never color alone" rule (paired with FileWarning icon).
 */
export function describeUploadRejection(rej: UploadRejection): string {
  switch (rej.reason) {
    case 'wrong_extension':
      return `${rej.filename ?? 'That file'} is not a supported workbook. Use .xlsx or .xlsm — .xls (binary 97-2003) and .csv are not accepted.`;
    case 'too_large': {
      const mb = rej.bytes ? (rej.bytes / (1024 * 1024)).toFixed(1) : '?';
      return `${rej.filename ?? 'That file'} is ${mb} MB. The cap is 10 MB; export a smaller workbook or split it into separate imports.`;
    }
    case 'empty':
      return `${rej.filename ?? 'That file'} is empty.`;
    case 'too_many_files':
      return 'Only one workbook per import. Drop a single .xlsx or .xlsm file.';
  }
}
