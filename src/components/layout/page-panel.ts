import { createContext, useContext } from 'react';

interface PanelState {
  /** The panel exists and is shown as a sheet (narrow windows). */
  collapsible: boolean;
  /** The sheet is showing. */
  isOpen: boolean;
  open: () => void;
  /** Closes the sheet after a choice. Does nothing when the panel is a column. */
  close: () => void;
}

export const PanelContext = createContext<PanelState>({ collapsible: false, isOpen: false, open: () => {}, close: () => {} });

/** Lets panel items close the sheet after a choice on narrow windows. */
export const usePagePanel = () => useContext(PanelContext);

