import { Plugin, WorkspaceLeaf, TFile, Menu, Notice } from 'obsidian';
import { DEFAULT_SETTINGS, SyncFileOnlySettings, SyncSettingTab } from "./settings";

export default class SyncFileOnlyPlugin extends Plugin {
	settings: SyncFileOnlySettings;
	private isSyncing = false;
	private linkedLeaves: Map<WorkspaceLeaf, Set<WorkspaceLeaf>> = new Map();

	async onload() {
		await this.loadSettings();

		this.addSettingTab(new SyncSettingTab(this.app, this));

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

		this.addCommand({
			id: 'unlink-pane-from-sync',
			name: 'Unlink this pane from sync',
			callback: () => {
				const activeLeaf = this.app.workspace.getLeaf();
				if (!activeLeaf) {
					return;
				}

				if (this.unlinkLeaf(activeLeaf)) {
					new Notice('Unlinked from sync');
				} else {
					new Notice('This pane is not linked');
				}
			}
		});

		this.registerFileTabMenu();

		this.registerEvent(
			this.app.workspace.on('active-leaf-change', (leaf: WorkspaceLeaf | null) => {
				if (!this.settings.enabled || this.isSyncing || !leaf) {
					return;
				}

				const view = leaf.view;
				const file = view && 'file' in view ? (view as { file: TFile }).file : null;
				if (file) {
					this.syncFileToLinkedLeaves(leaf, file);
					
					if (this.settings.autoRestoreLinks && this.linkedLeaves.has(leaf) && this.linkedLeaves.get(leaf)!.size > 0) {
						this.saveLinkStatesToSettings();
					}
				}
			})
		);

		this.registerEvent(
			this.app.workspace.on('layout-change', () => {
				this.cleanupClosedLeaves();
				this.updateLeafVisualIndicators();
			})
		);

		// Restore links on startup if enabled
		this.app.workspace.onLayoutReady(() => {
			if (this.settings.autoRestoreLinks) {
				this.restoreLinksFromSettings();
			}
		});

		this.updateLeafVisualIndicators();
	}

	onunload() {
		// Save current link states before unloading
		this.saveLinkStatesToSettings();
		this.linkedLeaves.clear();
	}

	private registerFileTabMenu() {
		this.registerEvent(
			this.app.workspace.on('file-menu', (menu: Menu, file: TFile, source: string, leaf?: WorkspaceLeaf) => {
				if (source === 'tab-header' && leaf) {
					this.addLinkMenuItem(menu, leaf);
				}
			})
		);
	}

	private addLinkMenuItem(menu: Menu, leaf: WorkspaceLeaf) {
		const isLinked = this.linkedLeaves.has(leaf) && this.linkedLeaves.get(leaf)!.size > 0;

		if (isLinked) {
			menu.addItem((item) => {
				item.setTitle('Unlink this pane from sync')
					.setIcon('unlink')
					.onClick(() => {
						if (this.unlinkLeaf(leaf)) {
							new Notice('Unlinked from sync');
						}
					});
			});
		} else {
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
	}

	private unlinkLeaf(leaf: WorkspaceLeaf): boolean {
		const linkedSet = this.linkedLeaves.get(leaf);
		if (!linkedSet || linkedSet.size === 0) {
			return false;
		}

		const [partner] = Array.from(linkedSet);
		if (partner) {
			this.linkedLeaves.delete(leaf);
			this.linkedLeaves.delete(partner);
			
			if (this.settings.autoRestoreLinks) {
				this.saveLinkStatesToSettings();
			}
			
			this.updateLeafVisualIndicators();
		}

		return true;
	}

	private linkLeafWithPartner(activeLeaf: WorkspaceLeaf, options: { createIfNone?: boolean } = {}): WorkspaceLeaf | null {
		const view = activeLeaf.view;
		const activeFile = view && 'file' in view ? (view as { file: TFile }).file : null;
		if (!activeFile) {
			return null;
		}

		const activeFilePath = activeFile.path;
		let partner: WorkspaceLeaf | null = null;

		const rootSplit = this.app.workspace.rootSplit;
		if (rootSplit) {
			this.app.workspace.iterateAllLeaves((leaf) => {
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
					return;
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
			
			if (this.settings.autoRestoreLinks) {
				this.saveLinkStatesToSettings();
			}
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
		this.app.workspace.iterateAllLeaves((leaf) => {
			const tabHeaderEl = (leaf as { tabHeaderEl?: HTMLElement }).tabHeaderEl;
			if (tabHeaderEl) {
				const existingIcon = tabHeaderEl.querySelector('.sync-indicator');
				if (existingIcon) {
					existingIcon.remove();
				}
			}
		});

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
		const activeLeaves = new Set<WorkspaceLeaf>();
		this.app.workspace.iterateAllLeaves((leaf) => {
			activeLeaves.add(leaf);
		});

		let hasChanges = false;
		const keysToDelete: WorkspaceLeaf[] = [];
		
		this.linkedLeaves.forEach((linkedSet, leaf) => {
			if (!activeLeaves.has(leaf)) {
				keysToDelete.push(leaf);
				hasChanges = true;
			} else {
				// Check if partner is still active
				const [partner] = Array.from(linkedSet);
				if (partner && !activeLeaves.has(partner)) {
					keysToDelete.push(leaf);
					hasChanges = true;
				}
			}
		});

		if (hasChanges) {
			keysToDelete.forEach((leaf) => {
				const linkedSet = this.linkedLeaves.get(leaf);
				if (linkedSet) {
					const [partner] = Array.from(linkedSet);
					if (partner) {
						this.linkedLeaves.delete(partner);
					}
				}
				this.linkedLeaves.delete(leaf);
			});
			
			if (this.settings.autoRestoreLinks) {
				this.saveLinkStatesToSettings();
			}
		}

		this.updateLeafVisualIndicators();
	}

	private saveLinkStatesToSettings() {
		const filePaths: string[] = [];
		const processedLeaves = new Set<WorkspaceLeaf>();

		this.linkedLeaves.forEach((linkedSet, leaf) => {
			if (processedLeaves.has(leaf) || linkedSet.size === 0) {
				return;
			}

			const view = leaf.view;
			const file = view && 'file' in view ? (view as { file: TFile }).file : null;
			if (!file) {
				return;
			}

			const [partner] = Array.from(linkedSet);
			if (!partner) {
				return;
			}

			filePaths.push(file.path);

			processedLeaves.add(leaf);
			processedLeaves.add(partner);
		});

		this.settings.savedPairs = filePaths;
		void this.saveSettings();
	}

	private restoreLinksFromSettings() {
		if (!this.settings.savedPairs || this.settings.savedPairs.length === 0) {
			return;
		}

		const rootSplit = this.app.workspace.rootSplit;
		if (!rootSplit) {
			return;
		}

		let restoredCount = 0;

		this.settings.savedPairs.forEach((filePath) => {
			const leaves: WorkspaceLeaf[] = [];

			this.app.workspace.iterateAllLeaves((leaf) => {
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
					return;
				}

				const view = leaf.view;
				const file = view && 'file' in view ? (view as { file: TFile }).file : null;
				if (!file) {
					return;
				}

				if (file.path === filePath) {
					leaves.push(leaf);
				}
			});

			if (leaves.length >= 2) {
				const leaf1 = leaves[0];
				const leaf2 = leaves[1];
				if (leaf1 && leaf2) {
					if (!this.linkedLeaves.has(leaf1)) {
						this.linkedLeaves.set(leaf1, new Set());
					}
					if (!this.linkedLeaves.has(leaf2)) {
						this.linkedLeaves.set(leaf2, new Set());
					}
					this.linkedLeaves.get(leaf1)!.clear();
					this.linkedLeaves.get(leaf2)!.clear();
					this.linkedLeaves.get(leaf1)!.add(leaf2);
					this.linkedLeaves.get(leaf2)!.add(leaf1);
					restoredCount++;
				}
			}
		});

		if (restoredCount > 0) {
			console.debug(`[SyncFile] Restored ${restoredCount} link pair(s)`);
		}

		this.updateLeafVisualIndicators();
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) as SyncFileOnlySettings);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}