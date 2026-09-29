import {
  createContext,
  useContext,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
  type Ref,
} from 'react';
import { createPortal } from 'react-dom';
import { DialogBackdrop } from '../DialogBackdrop.jsx';
import { DialogHeader, DialogBody } from '../DialogParts.jsx';
import { useAboveKeyboard } from '../useAboveKeyboard.js';
import {
  useDialogKeyboard,
  type DialogKeyboardOptions,
} from '../useDialogKeyboard.js';
import styles from './Dialog.module.css';
import { isMotionReduced } from '../../motion.js';

const stack: Array<{ element: HTMLElement; depth: number; order: number }> = [];
let nextOrder = 0;
const originalInert = new Map<HTMLElement, boolean>();
const EXIT_MS = 180;

export interface DialogHandle {
  close(onClosed?: () => void): void;
  cancelClose(): void;
  isClosing(): boolean;
}

function isolateBackground(): HTMLElement | undefined {
  const top = stack.reduce<(typeof stack)[number] | undefined>(
    (current, entry) =>
      !current ||
      entry.depth > current.depth ||
      (entry.depth === current.depth && entry.order > current.order)
        ? entry
        : current,
    undefined,
  )?.element;
  for (const child of Array.from(document.body.children)) {
    if (!(child instanceof HTMLElement)) continue;
    if (!originalInert.has(child))
      originalInert.set(child, child.inert === true);
    child.inert = child !== top;
  }
  if (!top) {
    for (const [element, inert] of originalInert) element.inert = inert;
    originalInert.clear();
  }
  return top;
}

const DialogContext = createContext<{
  contentRef: React.RefObject<HTMLDivElement | null>;
  depth: number;
  active: boolean;
} | null>(null);

function DialogRoot({
  open,
  active = true,
  dismissible = true,
  onClose,
  onKeyDown,
  initialFocus,
  closeRef,
  children,
  className = '',
  ...backdropProps
}: {
  open: boolean;
  active?: boolean;
  dismissible?: boolean;
  onClose(): boolean | void;
  onKeyDown?: DialogKeyboardOptions['onKeyDown'];
  initialFocus?: (content: HTMLElement) => HTMLElement | null;
  closeRef?: Ref<DialogHandle>;
  children: ReactNode;
} & Omit<
  ComponentProps<'div'>,
  'onClose' | 'onKeyDown' | 'children'
>): React.ReactElement | null {
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const completionRef = useRef<(() => void) | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const interactive = open && active && !closing;
  const close = (onClosed?: () => void): void => {
    if (closingRef.current) return;
    closingRef.current = true;
    completionRef.current =
      onClosed ??
      (() => {
        onCloseRef.current();
      });
    setClosing(true);
  };
  useImperativeHandle(closeRef, () => ({
    close,
    isClosing: () => closingRef.current,
    cancelClose() {
      closingRef.current = false;
      completionRef.current = null;
      setClosing(false);
    },
  }));
  useEffect(() => {
    if (!closing) return;
    const reduced = isMotionReduced();
    const timer = setTimeout(
      () => {
        if (!closingRef.current) return;
        closingRef.current = false;
        const completion = completionRef.current;
        completionRef.current = null;
        completion?.();
      },
      reduced ? 0 : EXIT_MS,
    );
    return () => clearTimeout(timer);
  }, [closing]);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const parent = useContext(DialogContext);
  const depth = (parent?.depth ?? 0) + 1;
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const initialFocusRef = useRef(initialFocus);
  initialFocusRef.current = initialFocus;
  const invokerRef = useRef<HTMLElement | null>(null);
  const focusOwnedRef = useRef(false);
  const keyboardRef = useAboveKeyboard<HTMLDivElement>();
  useDialogKeyboard(contentRef, {
    active: interactive,
    onEscape: dismissible ? close : undefined,
    onKeyDown,
  });

  useLayoutEffect(() => {
    if (!interactive || focusOwnedRef.current) return;
    invokerRef.current =
      document.activeElement instanceof HTMLElement &&
      document.activeElement !== document.body
        ? document.activeElement
        : (parent?.contentRef.current ?? null);
    focusOwnedRef.current = true;
  }, [interactive, parent]);

  useLayoutEffect(() => {
    if (!interactive || !backdropRef.current) return;
    const backdrop = backdropRef.current;
    contentRef.current ??= backdrop.querySelector<HTMLElement>(
      '[role="dialog"], [role="alertdialog"]',
    ) as HTMLDivElement | null;
    stack.push({ element: backdrop, depth, order: ++nextOrder });
    const top = isolateBackground();
    const content = contentRef.current;
    const focus =
      content &&
      (initialFocusRef.current?.(content) ??
        content.querySelector<HTMLElement>(
          '[autofocus], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ));
    if (top === backdrop) (focus ?? content)?.focus({ preventScroll: true });
    return () => {
      const index = stack.findIndex((entry) => entry.element === backdrop);
      if (index >= 0) stack.splice(index, 1);
      isolateBackground();
    };
  }, [interactive, depth]);

  useLayoutEffect(() => {
    if (interactive) return;
    returnFocus();
  }, [interactive]);

  useLayoutEffect(() => () => returnFocus(), []);

  useLayoutEffect(() => {
    const backdrop = backdropRef.current;
    const content = contentRef.current;
    if (!open || !backdrop || !content || typeof ResizeObserver === 'undefined') {
      return;
    }

    const update = () => {
      // Measure the ordinary card, independent of its decorative keyboard tail
      // and entrance transforms.
      content.removeAttribute('data-fl-keyboard-contact');
      const backdropStyle = getComputedStyle(backdrop);
      const keyboardHeight = parseFloat(
        backdropStyle.getPropertyValue('--fl-keyboard-inset-height'),
      );
      const bottom = backdrop.clientHeight - parseFloat(backdropStyle.paddingBottom);
      if (!(keyboardHeight > 0) || content.offsetTop + content.offsetHeight < bottom - 1) {
        return;
      }

      const style = getComputedStyle(content);
      const radius = Math.max(
        parseFloat(style.borderBottomLeftRadius),
        parseFloat(style.borderBottomRightRadius),
      );
      if (!(radius > 0)) return;
      content.style.setProperty('--fl-dialog-keyboard-tail', `${radius}px`);
      content.style.setProperty('--fl-dialog-bottom-padding', style.paddingBottom);
      content.setAttribute('data-fl-keyboard-contact', '');
    };
    const observer = new ResizeObserver(update);
    observer.observe(backdrop);
    observer.observe(content);
    update();
    return () => {
      observer.disconnect();
      content.removeAttribute('data-fl-keyboard-contact');
      content.style.removeProperty('--fl-dialog-keyboard-tail');
      content.style.removeProperty('--fl-dialog-bottom-padding');
    };
  }, [open]);

  function returnFocus(): void {
    if (!focusOwnedRef.current) return;
    focusOwnedRef.current = false;
    const focused = document.activeElement;
    if (focused === document.body || contentRef.current?.contains(focused)) {
      const parentDialog = stack
        .reduce<
          (typeof stack)[number] | undefined
        >((current, entry) => (!current || entry.depth > current.depth || (entry.depth === current.depth && entry.order > current.order) ? entry : current), undefined)
        ?.element.querySelector<HTMLElement>(
          '[role="dialog"], [role="alertdialog"]',
        );
      const target = invokerRef.current?.isConnected
        ? invokerRef.current
        : (parent?.contentRef.current ?? parentDialog);
      target?.focus({ preventScroll: true });
    }
    invokerRef.current = null;
  }

  if (!open) return null;
  return createPortal(
    <DialogContext.Provider value={{ contentRef, depth, active: interactive }}>
      <DialogBackdrop
        {...backdropProps}
        ref={(element) => {
          backdropRef.current = element;
          keyboardRef(element);
        }}
        className={`${styles.backdrop} ${className}`}
        data-closing={closing || !active || undefined}
        onDismiss={() => {
          if (interactive && dismissible) close();
        }}
      >
        {children}
      </DialogBackdrop>
    </DialogContext.Provider>,
    document.body,
  );
}

function Content({
  className = '',
  unstyled = false,
  ref,
  ...props
}: ComponentProps<'div'> & { unstyled?: boolean }): React.ReactElement {
  const context = useContext(DialogContext);
  if (!context) throw new Error('Dialog.Content requires Dialog');
  return (
    <div
      role="dialog"
      tabIndex={-1}
      {...props}
      aria-modal={context.active ? 'true' : undefined}
      inert={!context.active || undefined}
      ref={(element) => {
        context.contentRef.current = element;
        if (typeof ref === 'function') ref(element);
        else if (ref) ref.current = element;
      }}
      className={unstyled ? className : `${styles.content} ${className}`}
    />
  );
}

function Footer({
  className = '',
  ...props
}: ComponentProps<'footer'>): React.ReactElement {
  return <footer {...props} className={`${styles.footer} ${className}`} />;
}

export const Dialog = Object.assign(DialogRoot, {
  Content,
  Header: DialogHeader,
  Body: DialogBody,
  Footer,
});
