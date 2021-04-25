import { Item, Share, ShareType, ShareUser, ShareUserStatus, User, Uuid } from '../db';
import { ErrorForbidden, ErrorNotFound } from '../utils/errors';
import BaseModel, { AclAction } from './BaseModel';

export default class ShareUserModel extends BaseModel<ShareUser> {

	public get tableName(): string {
		return 'share_users';
	}

	public async checkIfAllowed(user: User, action: AclAction, resource: ShareUser = null): Promise<void> {
		if (action === AclAction.Create) {
			const share = await this.models().share().load(resource.share_id);
			if (share.owner_id !== user.id) throw new ErrorForbidden('no access to the share object');
		}

		if (action === AclAction.Update) {
			if (user.id !== resource.user_id) throw new ErrorForbidden('cannot change share user');
		}
	}

	public async byUserId(userId: Uuid): Promise<ShareUser[]> {
		return this.db(this.tableName).select(this.defaultFields).where('user_id', '=', userId);
	}

	public async byShareId(shareId: Uuid): Promise<ShareUser[]> {
		const r = await this.byShareIds([shareId]);
		return Object.keys(r).length > 0 ? r[shareId] : null;
		// return this.db(this.tableName).select(this.defaultFields).where('share_id', '=', shareId);
	}

	public async byShareIds(shareIds: Uuid[]): Promise<Record<Uuid, ShareUser[]>> {
		const rows: ShareUser[] = await this.db(this.tableName).select(this.defaultFields).whereIn('share_id', shareIds);
		const output: Record<Uuid, ShareUser[]> = {};

		for (const row of rows) {
			if (!(row.share_id in output)) output[row.share_id] = [];
			output[row.share_id].push(row);
		}

		return output;
	}

	public async loadByShareIdAndUser(shareId: Uuid, userId: Uuid): Promise<ShareUser> {
		const link: ShareUser = {
			share_id: shareId,
			user_id: userId,
		};

		return this.db(this.tableName).where(link).first();
	}

	public async shareWithUserAndAccept(share: Share, shareeId: Uuid) {
		await this.models().shareUser().addById(share.id, shareeId);
		await this.models().shareUser().setStatus(share.id, shareeId, ShareUserStatus.Accepted);
	}

	public async addById(shareId: Uuid, userId: Uuid): Promise<ShareUser> {
		const user = await this.models().user().load(userId);
		return this.addByEmail(shareId, user.email);
	}

	public async byShareAndEmail(shareId: Uuid, userEmail: string): Promise<ShareUser> {
		const user = await this.models().user().loadByEmail(userEmail);
		if (!user) throw new ErrorNotFound(`No such user: ${userEmail}`);

		return this.db(this.tableName).select(this.defaultFields)
			.where('share_id', '=', shareId)
			.where('user_id', '=', user.id)
			.first();
	}

	public async addByEmail(shareId: Uuid, userEmail: string): Promise<ShareUser> {
		// TODO: check that user can access this share
		const share = await this.models().share().load(shareId);
		if (!share) throw new ErrorNotFound(`No such share: ${shareId}`);

		const user = await this.models().user().loadByEmail(userEmail);
		if (!user) throw new ErrorNotFound(`No such user: ${userEmail}`);

		return this.save({
			share_id: shareId,
			user_id: user.id,
		});
	}

	public async setStatus(shareId: Uuid, userId: Uuid, status: ShareUserStatus): Promise<Item> {
		const shareUser = await this.loadByShareIdAndUser(shareId, userId);
		if (!shareUser) throw new ErrorNotFound(`Item has not been shared with this user: ${shareId} / ${userId}`);

		const share = await this.models().share().load(shareId);
		if (!share) throw new ErrorNotFound(`No such share: ${shareId}`);

		const item = await this.models().item().load(share.item_id);

		return this.withTransaction<Item>(async () => {
			await this.save({ ...shareUser, status });

			if (status === ShareUserStatus.Accepted) {
				if (share.type === ShareType.JoplinRootFolder) {
					await this.models().item().shareJoplinFolderAndContent(share.id, share.owner_id, userId, item.jop_id);
				} else if (share.type === ShareType.App) {
					await this.models().userItem().add(userId, share.item_id, share.id);
				}
			}
		});
	}

	public async deleteByShare(share: Share): Promise<void> {
		const shareUsers = await this.byShareId(share.id);

		await this.withTransaction(async () => {
			await this.delete(shareUsers.map(s => s.id));
		}, 'ShareUserModel::delete');
	}

}