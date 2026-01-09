import { Plugin, WorkspaceLeaf, TFile, Menu, Notice } from 'obsidian';
import { DEFAULT_SETTINGS, SyncFileOnlySettings, SyncSettingTab } from "./settings";

export default class SyncFileOnlyPlugin extends Plugin {
	settings: SyncFileOnlySettings;
	private isSyncing = false;
	private linkedLeaves: Map<WorkspaceLeaf, Set<WorkspaceLeaf>> = new Map();

	async onload() {
		await this.loadSettings();

		// Register the settings tab
		this.addSettingTab(new SyncSettingTab(this.app, this));

		// Add command to link panes for syncing
		this.addCommand({
			id: 'link-pane-for-sync',
			name: 'Link this pane for file sync',
			callback: () => {
				const activeLeaf = this.app.workspace.getLeaf();
				if (!activeLeaf) {
					return;
				}

				const partner = this.linkLeafWithPartner(activeLeaf, { createIfNone: true });
				if (partner) {
					new Notice('Linked with one pane for sync');
				} else {
					new Notice('No pane found or created to link');
				}
			}
		});

		// Add right-click menu entry on file tabs (typed API: file-menu with source "tab-header")
		this.registerFileTabMenu();

		// Listen for active leaf changes to sync linked panes
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', (leaf: WorkspaceLeaf | null) => {
				if (!this.settings.enabled || this.isSyncing || !leaf) {
					return;
				}

				const view = leaf.view;
				const file = view && 'file' in view ? (view as { file: TFile }).file : null;
				if (file) {
					this.syncFileToLinkedLeaves(leaf, file);
				}
			})
		);

		// Clean up linked leaves when they are closed
		this.registerEvent(
			this.app.workspace.on('layout-change', () => {
				this.cleanupClosedLeaves();
				this.updateLeafVisualIndicators();
			})
		);

		// Initialize visual indicators
		this.updateLeafVisualIndicators();
	}

	onunload() {
		this.linkedLeaves.clear();
	}

	private registerFileTabMenu() {
		// file-menu is typed and fires for tab headers with source === "tab-header"
		this.registerEvent(
			this.app.workspace.on('file-menu', (menu: Menu, file: TFile, source: string, leaf?: WorkspaceLeaf) => {
				if (source === 'tab-header' && leaf) {
					this.addLinkMenuItem(menu, leaf);
				}
			})
		);
	}

	private addLinkMenuItem(menu: Menu, leaf: WorkspaceLeaf) {
		menu.addItem((item) => {
			item.setTitle('Link this pane for file sync')
				.setIcon('link')
				.onClick(() => {
					const partner = this.linkLeafWithPartner(leaf, { createIfNone: true });
					if (partner) {
						new Notice('Linked with one pane for sync');
					} else {
						new Notice('No pane found or created to link');
					}
				});
		});
	}

	private linkLeafWithPartner(activeLeaf: WorkspaceLeaf, options: { createIfNone?: boolean } = {}): WorkspaceLeaf | null {
		const view = activeLeaf.view;
		const activeFile = view && 'file' in view ? (view as { file: TFile }).file : null;
		if (!activeFile) {
			return null;
		}

		const activeFilePath = activeFile.path;
		let partner: WorkspaceLeaf | null = null;

		// Only search in main workspace area (rootSplit), not sidebars
		const rootSplit = this.app.workspace.rootSplit;
		if (rootSplit) {
			this.app.workspace.iterateAllLeaves((leaf) => {
				// Skip if leaf is not in main area (check if it's descendant of rootSplit)
				let parent: unknown = leaf.parent;
				let isInRootSplit = false;
				while (parent) {
					if (parent === rootSplit) {
						isInRootSplit = true;
						break;
					}
					parent = (parent as { parent?: unknown }).parent;
				}

				if (!isInRootSplit) {
					return; // Skip sidebar leaves
				}
				
				if (leaf !== activeLeaf && !partner) {
					const leafView = leaf.view;
					const leafFile = leafView && 'file' in leafView ? (leafView as { file: TFile }).file : null;
					if (leafFile && leafFile.path === activeFilePath) {
						partner = leaf;
					}
				}
			});
		}

		// If no leaf has this file open and allowed, create a new split with the same file
		if (!partner && options.createIfNone) {
			const newLeaf = this.app.workspace.createLeafBySplit(activeLeaf, 'vertical', false);
			if (newLeaf) {
				void newLeaf.openFile(activeFile);
				partner = newLeaf;
			}
		}

		if (partner) {
			if (!this.linkedLeaves.has(activeLeaf)) {
				this.linkedLeaves.set(activeLeaf, new Set());
			}
			if (!this.linkedLeaves.has(partner)) {
				this.linkedLeaves.set(partner, new Set());
			}
			this.linkedLeaves.get(activeLeaf)!.clear();
			this.linkedLeaves.get(partner)!.clear();
			this.linkedLeaves.get(activeLeaf)!.add(partner);
			this.linkedLeaves.get(partner)!.add(activeLeaf);
			this.updateLeafVisualIndicators();
		}

		return partner;
	}

	private syncFileToLinkedLeaves(sourceLeaf: WorkspaceLeaf, file: TFile) {
		if (!file) return;

		try {
			this.isSyncing = true;

			const linkedSet = this.linkedLeaves.get(sourceLeaf);
			if (linkedSet && linkedSet.size > 0) {
				const [leaf] = Array.from(linkedSet);
				if (leaf?.view) {
					void leaf.openFile(file);
				}
			}
		} finally {
			this.isSyncing = false;
		}
	}

	private updateLeafVisualIndicators() {
		// Remove all existing indicators
		this.app.workspace.iterateAllLeaves((leaf) => {
			const tabHeaderEl = (leaf as { tabHeaderEl?: HTMLElement }).tabHeaderEl;
			if (tabHeaderEl) {
				const existingIcon = tabHeaderEl.querySelector('.sync-indicator');
				if (existingIcon) {
					existingIcon.remove();
				}
			}
		});

		// Add indicators to linked leaves
		this.linkedLeaves.forEach((linkedSet, leaf) => {
			if (linkedSet.size > 0) {
				const tabHeaderEl = (leaf as { tabHeaderEl?: HTMLElement }).tabHeaderEl;
				if (tabHeaderEl) {
					const indicator = tabHeaderEl.createDiv('sync-indicator');
					indicator.setAttribute('aria-label', 'This pane is linked for file sync');
					indicator.textContent = '🔗';
				}
			}
		});
	}

	private cleanupClosedLeaves() {
		// Remove entries for leaves that no longer exist
		const activeLeaves = new Set<WorkspaceLeaf>();
		this.app.workspace.iterateAllLeaves((leaf) => {
			activeLeaves.add(leaf);
		});

		const keysToDelete: WorkspaceLeaf[] = [];
		this.linkedLeaves.forEach((linkedSet, leaf) => {
			if (!activeLeaves.has(leaf)) {
				keysToDelete.push(leaf);
			}
		});

		keysToDelete.forEach((leaf) => {
			this.linkedLeaves.delete(leaf);
		});

		this.updateLeafVisualIndicators();
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) as SyncFileOnlySettings);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
