import { clipboard, Menu, type MenuItemConstructorOptions, type WebContents } from 'electron';

/**
 * Electron has no right-click menu of its own, so this is the page's: spelling suggestions,
 * cut/copy/paste in text boxes, and links and images. The page's own menus (on messages,
 * people…) call preventDefault and never get here.
 */
export type ContextMenuActions = { openExternal(url: string): void; beforeSaveAs(): void };

export function attachContextMenu(contents: WebContents, actions: ContextMenuActions): void {
  contents.on('context-menu', (_event, params) => {
    const items: MenuItemConstructorOptions[] = [];
    const section = (more: MenuItemConstructorOptions[]) => {
      if (more.length === 0) return;
      if (items.length > 0) items.push({ type: 'separator' });
      items.push(...more);
    };

    if (params.misspelledWord) {
      const suggestions: MenuItemConstructorOptions[] = params.dictionarySuggestions
        .slice(0, 5)
        .map((word) => ({ label: word, click: () => contents.replaceMisspelling(word) }));
      if (suggestions.length === 0) suggestions.push({ label: 'No suggestions', enabled: false });
      suggestions.push({
        label: 'Add to dictionary',
        click: () => contents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
      });
      section(suggestions);
    }

    if (params.linkURL && /^(https?|mailto):/i.test(params.linkURL)) {
      section([
        { label: 'Open link in browser', click: () => actions.openExternal(params.linkURL) },
        { label: params.linkURL.startsWith('mailto:') ? 'Copy email address' : 'Copy link', click: () => clipboard.writeText(params.linkURL.replace(/^mailto:/i, '')) },
      ]);
    }

    if (params.mediaType === 'image' && params.srcURL) {
      section([
        { label: 'Copy image', click: () => contents.copyImageAt(params.x, params.y) },
        {
          label: 'Save image as…',
          click: () => {
            actions.beforeSaveAs();
            contents.downloadURL(params.srcURL);
          },
        },
      ]);
    }

    const f = params.editFlags;
    if (params.isEditable) {
      section([
        { label: 'Undo', role: 'undo', enabled: f.canUndo },
        { label: 'Redo', role: 'redo', enabled: f.canRedo },
        { type: 'separator' },
        { label: 'Cut', role: 'cut', enabled: f.canCut },
        { label: 'Copy', role: 'copy', enabled: f.canCopy },
        { label: 'Paste', role: 'paste', enabled: f.canPaste },
        { label: 'Paste as plain text', role: 'pasteAndMatchStyle', enabled: f.canPaste },
        { type: 'separator' },
        { label: 'Select all', role: 'selectAll', enabled: f.canSelectAll },
      ]);
    } else if (params.selectionText.trim()) {
      section([{ label: 'Copy', role: 'copy', enabled: f.canCopy }]);
    }

    if (items.length > 0) Menu.buildFromTemplate(items).popup();
  });
}
