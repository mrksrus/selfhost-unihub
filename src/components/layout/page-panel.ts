import { createContext, useContext } from 'react';

interface PanelState {
  /** The panel exists and opens as a sheet: on narrow windows, or folded away on wide ones. */
  collapsible: boolean;
  /** The sheet is showing. */
  isOpen: boolean;
  open: () => void;
  /** Closes the sheet after a choice. Does nothing when the panel is a column. */
  close: () => void;
  /** Wide window with a panel: the column can be folded away. */
  foldable: boolean;
  /** The column is folded away (wide windows only); the panel then opens as a sheet. */
  folded: boolean;
  setFolded: (folded: boolean) => void;
}

export const PanelContext = createContext<PanelState>({ collapsible: false, isOpen: false, open: () => {}, close: () => {}, foldable: false, folded: false, setFolded: () => {} });

/** Lets panel items close the sheet after a choice, and the panel header fold the column. */
export const usePagePanel = () => useContext(PanelContext);
