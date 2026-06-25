import { ComponentType, ReactNode } from 'react';
import { TLUiActionsMenuProps } from '../components/ActionsMenu/DefaultActionsMenu';
import { TLUiContextMenuProps } from '../components/ContextMenu/DefaultContextMenu';
import { TLUiHelperButtonsProps } from '../components/HelperButtons/DefaultHelperButtons';
import { TLUiHelpMenuProps } from '../components/HelpMenu/DefaultHelpMenu';
import { TLUiKeyboardShortcutsDialogProps } from '../components/KeyboardShortcutsDialog/DefaultKeyboardShortcutsDialog';
import { TLUiMainMenuProps } from '../components/MainMenu/DefaultMainMenu';
import { TLUiQuickActionsProps } from '../components/QuickActions/DefaultQuickActions';
import { TLUiPeopleMenuAvatarProps } from '../components/SharePanel/DefaultPeopleMenuAvatar';
import { TLUiPeopleMenuFacePileProps } from '../components/SharePanel/DefaultPeopleMenuFacePile';
import { TLUiPeopleMenuItemProps } from '../components/SharePanel/DefaultPeopleMenuItem';
import { TLUiStylePanelProps } from '../components/StylePanel/DefaultStylePanel';
import { TLUiRichTextToolbarProps } from '../components/Toolbar/DefaultRichTextToolbar';
import { TLUiZoomMenuProps } from '../components/ZoomMenu/DefaultZoomMenu';
/** @public */
export interface TLUiComponents {
    ContextMenu?: ComponentType<TLUiContextMenuProps> | null;
    ActionsMenu?: ComponentType<TLUiActionsMenuProps> | null;
    HelpMenu?: ComponentType<TLUiHelpMenuProps> | null;
    ZoomMenu?: ComponentType<TLUiZoomMenuProps> | null;
    MainMenu?: ComponentType<TLUiMainMenuProps> | null;
    Minimap?: ComponentType | null;
    StylePanel?: ComponentType<TLUiStylePanelProps> | null;
    PageMenu?: ComponentType | null;
    NavigationPanel?: ComponentType | null;
    Toolbar?: ComponentType | null;
    RichTextToolbar?: ComponentType<TLUiRichTextToolbarProps> | null;
    ImageToolbar?: ComponentType | null;
    VideoToolbar?: ComponentType | null;
    KeyboardShortcutsDialog?: ComponentType<TLUiKeyboardShortcutsDialogProps> | null;
    QuickActions?: ComponentType<TLUiQuickActionsProps> | null;
    HelperButtons?: ComponentType<TLUiHelperButtonsProps> | null;
    DebugPanel?: ComponentType | null;
    DebugMenu?: ComponentType | null;
    MenuPanel?: ComponentType | null;
    TopPanel?: ComponentType | null;
    SharePanel?: ComponentType | null;
    CursorChatBubble?: ComponentType | null;
    Dialogs?: ComponentType | null;
    Toasts?: ComponentType | null;
    A11y?: ComponentType | null;
    FollowingIndicator?: ComponentType | null;
    PeopleMenu?: ComponentType | null;
    PeopleMenuAvatar?: ComponentType<TLUiPeopleMenuAvatarProps> | null;
    PeopleMenuItem?: ComponentType<TLUiPeopleMenuItemProps> | null;
    PeopleMenuFacePile?: ComponentType<TLUiPeopleMenuFacePileProps> | null;
    UserPresenceEditor?: ComponentType | null;
}
/** @public */
export interface TLUiComponentsProviderProps {
    overrides?: TLUiComponents;
    children: ReactNode;
}
/** @public @react */
export declare function TldrawUiComponentsProvider({ overrides, children }: TLUiComponentsProviderProps): import("react/jsx-runtime").JSX.Element;
/** @public */
export declare function useTldrawUiComponents(): TLUiComponents;
//# sourceMappingURL=components.d.ts.map