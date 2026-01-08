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
				const activeLeaf = this.app.workspace.activeLeaf;
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

		// Listen for file opens in workspace
		this.registerEvent(
			this.app.workspace.on('file-open', (file: TFile | null) => {
				if (!this.settings.enabled || this.isSyncing || !file) {
					return;
				}

				const leaf = this.app.workspace.activeLeaf;
				if (leaf && leaf.view) {
					this.syncFileToLinkedLeaves(leaf, file);
				}
			})
		);

		// Clean up linked leaves when they are closed
		this.registerEvent(
			this.app.workspace.on('layout-change', () => {
				this.cleanupClosedLeaves();
			})
		);
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
		menu.addItem((item: any) => {
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
		const activeFile = (activeLeaf.view as any)?.file as TFile | null;
		if (!activeFile) {
			console.log('No active file found');
			return null;
		}

		const activeFilePath = activeFile.path;
		let partner: WorkspaceLeaf | null = null;

		console.log('Active leaf:', activeLeaf, 'File:', activeFilePath);

		// Only search in main workspace area (rootSplit), not sidebars
		const rootSplit = this.app.workspace.rootSplit;
		if (rootSplit) {
			let leafCount = 0;
			this.app.workspace.iterateAllLeaves((leaf) => {
				// Skip if leaf is not in main area (check if it's descendant of rootSplit)
				let parent = leaf.parent;
				let isInRootSplit = false;
				while (parent) {
					if (parent === rootSplit) {
						isInRootSplit = true;
						break;
					}
					parent = (parent as any).parent;
				}

				if (!isInRootSplit) {
					return; // Skip sidebar leaves
				}

				leafCount++;
				const isSameLeaf = leaf === activeLeaf;
				const leafFile = (leaf.view as any)?.file as TFile | null;
				console.log(`Leaf ${leafCount} (main area): isSame=${isSameLeaf}, file=${leafFile?.path}, alreadyFoundPartner=${!!partner}`);
				
				if (leaf !== activeLeaf && !partner) {
					if (leafFile && leafFile.path === activeFilePath) {
						console.log('Found partner with same file:', leafFile.path);
						partner = leaf;
					}
				}
			});
			console.log(`Total leaves in main area: ${leafCount}, Partner found: ${!!partner}`);
		}

		// If no leaf has this file open and allowed, create a new split with the same file
		if (!partner && options.createIfNone) {
			console.log('Creating new split for file:', activeFilePath);
			try {
				const newLeaf = this.app.workspace.createLeafBySplit(activeLeaf, 'vertical', false);
				console.log('New leaf created:', newLeaf);
				if (newLeaf) {
					// Open file immediately (returns promise but don't need to await for pairing)
					newLeaf.openFile(activeFile);
					partner = newLeaf;
					console.log('Partner set to new leaf');
				}
			} catch (e) {
				console.error('Failed to create split:', e);
			}
		} else if (!partner) {
			console.log('No partner found and createIfNone is false');
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
			console.log('Linked activeLeaf === partner?', activeLeaf === partner);
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
					leaf.openFile(file);
				}
			}
		} finally {
			this.isSyncing = false;
		}
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
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
