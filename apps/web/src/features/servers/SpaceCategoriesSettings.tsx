import { useState, type FormEvent } from 'react';
import type { Room } from 'matrix-js-sdk';
import {
  createCategory,
  deleteCategory,
  moveChannelToCategory,
  renameCategory,
  reorderCategories,
  reorderCategoryChannels,
  type ChannelCategory,
} from '../../matrix/channelCategories';
import { useChannelCategories } from '../../matrix/hooks/useChannelCategories';
import { useSpaceRooms } from '../../matrix/hooks/useSpaceRooms';
import { useMatrixClient } from '../../matrix/MatrixClientContext';

function CategoryRow({
  space,
  category,
  rooms,
  uncategorizedRooms,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
}: {
  space: Room;
  category: ChannelCategory;
  rooms: Room[];
  uncategorizedRooms: Room[];
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const mx = useMatrixClient();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(category.name);
  const [addChannelId, setAddChannelId] = useState('');
  const [error, setError] = useState<string>();

  const submitRename = (evt: FormEvent) => {
    evt.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setRenaming(false);
    if (trimmed !== category.name) {
      renameCategory(mx, space, category.id, trimmed).catch((err) => setError(String(err)));
    }
  };

  const handleAddChannel = () => {
    if (!addChannelId) return;
    moveChannelToCategory(mx, space, addChannelId, category.id)
      .then(() => setAddChannelId(''))
      .catch((err) => setError(String(err)));
  };

  const handleRemoveChannel = (roomId: string) => {
    moveChannelToCategory(mx, space, roomId, null).catch((err) => setError(String(err)));
  };

  const handleDelete = () => {
    deleteCategory(mx, space, category.id).catch((err) => setError(String(err)));
  };

  const moveChannel = (index: number, direction: -1 | 1) => {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= rooms.length) return;
    const newOrder = rooms.map((r) => r.roomId);
    [newOrder[index], newOrder[targetIndex]] = [newOrder[targetIndex], newOrder[index]];
    reorderCategoryChannels(mx, space, category.id, newOrder).catch((err) => setError(String(err)));
  };

  return (
    <div className="nu-space-categories__category" data-nu-role="space-categories-category">
      <div className="nu-space-categories__category-header">
        {renaming ? (
          <form className="nu-space-categories__rename-form" onSubmit={submitRename}>
            <input
              className="nu-field__input"
              value={name}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              onBlur={submitRename}
            />
          </form>
        ) : (
          <button
            type="button"
            className="nu-space-categories__category-name"
            data-nu-role="space-categories-rename"
            onClick={() => setRenaming(true)}
            title="Click to rename"
          >
            {category.name}
          </button>
        )}
        <div className="nu-space-categories__category-actions">
          <button
            type="button"
            className="nu-space-categories__icon-button"
            disabled={!canMoveUp}
            onClick={onMoveUp}
            title="Move category up"
          >
            ↑
          </button>
          <button
            type="button"
            className="nu-space-categories__icon-button"
            disabled={!canMoveDown}
            onClick={onMoveDown}
            title="Move category down"
          >
            ↓
          </button>
          <button
            type="button"
            className="nu-space-categories__icon-button nu-space-categories__icon-button--danger"
            data-nu-role="space-categories-delete"
            onClick={handleDelete}
            title="Delete category"
          >
            ×
          </button>
        </div>
      </div>
      <div className="nu-space-categories__channels">
        {rooms.length === 0 && <p className="nu-space-categories__empty">No channels in this category yet.</p>}
        {rooms.map((room, index) => (
          <div key={room.roomId} className="nu-space-categories__channel-row" data-nu-role="space-categories-channel-row">
            <span className="nu-space-categories__channel-name">{room.name}</span>
            <button
              type="button"
              className="nu-space-categories__icon-button"
              disabled={index === 0}
              onClick={() => moveChannel(index, -1)}
              title="Move up"
            >
              ↑
            </button>
            <button
              type="button"
              className="nu-space-categories__icon-button"
              disabled={index === rooms.length - 1}
              onClick={() => moveChannel(index, 1)}
              title="Move down"
            >
              ↓
            </button>
            <button
              type="button"
              className="nu-space-categories__icon-button"
              data-nu-role="space-categories-remove-channel"
              onClick={() => handleRemoveChannel(room.roomId)}
              title="Remove from category"
            >
              ×
            </button>
          </div>
        ))}
      </div>
      {uncategorizedRooms.length > 0 && (
        <div className="nu-space-categories__add-channel">
          <select
            className="nu-field__input"
            data-nu-role="space-categories-add-select"
            value={addChannelId}
            onChange={(e) => setAddChannelId(e.target.value)}
          >
            <option value="">Add a channel…</option>
            {uncategorizedRooms.map((room) => (
              <option key={room.roomId} value={room.roomId}>
                {room.name}
              </option>
            ))}
          </select>
          <button type="button" className="nu-button nu-button--secondary" disabled={!addChannelId} onClick={handleAddChannel}>
            Add
          </button>
        </div>
      )}
      {error && <p className="nu-field__error">{error}</p>}
    </div>
  );
}

/**
 * Discord-style category management — see channelCategories.ts for the data model. Creating,
 * renaming and deleting categories happen here; arranging them is quicker by dragging in the
 * channel list itself (features/channels/useChannelDrag.ts), and the up/down buttons here remain
 * for doing it without a pointer.
 */
export function SpaceCategoriesSettings({ space }: { space: Room }) {
  const mx = useMatrixClient();
  const categories = useChannelCategories(space);
  const spaceRooms = useSpaceRooms(space.roomId);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();

  const categorizedIds = new Set(categories.flatMap((c) => c.channelIds));
  const uncategorizedRooms = spaceRooms.filter((r) => !categorizedIds.has(r.roomId));
  const roomById = new Map(spaceRooms.map((r) => [r.roomId, r]));

  const handleCreate = async (evt: FormEvent) => {
    evt.preventDefault();
    const trimmed = newCategoryName.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    setError(undefined);
    try {
      await createCategory(mx, space, trimmed);
      setNewCategoryName('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create category');
    } finally {
      setCreating(false);
    }
  };

  const moveCategory = (index: number, direction: -1 | 1) => {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= categories.length) return;
    const newOrder = categories.map((c) => c.id);
    [newOrder[index], newOrder[targetIndex]] = [newOrder[targetIndex], newOrder[index]];
    reorderCategories(mx, space, newOrder).catch((err) => setError(String(err)));
  };

  return (
    <div className="nu-space-categories" data-nu-role="space-categories">
      <p className="nu-space-categories__note">
        Group this Space's channels into collapsible categories, like Discord — a channel not
        added to any category shows above the categories, ungrouped, exactly like before any
        categories existed.
      </p>
      <form className="nu-modal-form" onSubmit={handleCreate}>
        <div className="nu-form-actions">
          <input
            className="nu-field__input"
            data-nu-role="space-categories-new-name"
            value={newCategoryName}
            onChange={(e) => setNewCategoryName(e.target.value)}
            placeholder="New category name"
          />
          <button type="submit" className="nu-button nu-button--primary" disabled={!newCategoryName.trim() || creating}>
            {creating ? 'Creating…' : 'Create'}
          </button>
        </div>
      </form>
      {error && <p className="nu-field__error">{error}</p>}
      <div className="nu-space-categories__list">
        {categories.map((category, index) => (
          <CategoryRow
            key={category.id}
            space={space}
            category={category}
            rooms={category.channelIds.map((id) => roomById.get(id)).filter((r): r is Room => !!r)}
            uncategorizedRooms={uncategorizedRooms}
            canMoveUp={index > 0}
            canMoveDown={index < categories.length - 1}
            onMoveUp={() => moveCategory(index, -1)}
            onMoveDown={() => moveCategory(index, 1)}
          />
        ))}
        {categories.length === 0 && <p className="nu-space-categories__empty">No categories yet.</p>}
      </div>
    </div>
  );
}
