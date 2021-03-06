import NylasStore from 'nylas-store'
import Actions from '../actions'
import Utils from '../models/utils'
import TaskFactory from '../tasks/task-factory'
import AccountStore from '../stores/account-store'
import FocusedPerspectiveStore from '../stores/focused-perspective-store'


class ThreadListActionsStore extends NylasStore {

  constructor() {
    super()
    this._timers = new Map()
  }

  activate() {
    if (!NylasEnv.isMainWindow()) { return }
    this.listenTo(Actions.archiveThreads, this._onArchiveThreads)
    this.listenTo(Actions.trashThreads, this._onTrashThreads)
    this.listenTo(Actions.markAsSpamThreads, this._onMarkAsSpamThreads)
    this.listenTo(Actions.toggleStarredThreads, this._onToggleStarredThreads)
    this.listenTo(Actions.toggleUnreadThreads, this._onToggleUnreadThreads)
    this.listenTo(Actions.setUnreadThreads, this._onSetUnreadThreads)
    this.listenTo(Actions.removeThreadsFromView, this._onRemoveThreadsFromView)
    this.listenTo(Actions.moveThreadsToPerspective, this._onMoveThreadsToPerspective)
    this.listenTo(Actions.removeCategoryFromThreads, this._onRemoveCategoryFromThreads)
    this.listenTo(Actions.applyCategoryToThreads, this._onApplyCategoryToThreads)
    this.listenTo(Actions.threadListDidUpdate, this._onThreadListDidUpdate)
  }

  deactivate() {
    this.stopListeningToAll()
  }

  _onThreadListDidUpdate = (threads) => {
    const updatedAt = Date.now()
    const threadIdsInList = new Set(threads.map(t => t.id))

    for (const [timerId, timerData] of this._timers.entries()) {
      const {threadIds, provider, source, action, targetCategory} = timerData
      const threadsHaveBeenRemoved = threadIds.every(id => !threadIdsInList.has(id))
      if (threadsHaveBeenRemoved) {
        const actionTimeMs = NylasEnv.timer.stop(timerId, updatedAt)
        Actions.recordPerfMetric({
          action,
          source,
          provider,
          actionTimeMs,
          targetCategory,
          threadCount: threadIds.length,
          sample: 0.9,
        })
        this._timers.delete(timerId)
      }
    }
  }

  _setNewTimer({threads, threadIds, accountIds, source, action, targetCategory = 'unknown'} = {}) {
    if (!threads && !threadIds) {
      return
    }
    if (threadIds && !accountIds) {
      throw new Error('ThreadListActionStore._setNewTimer: Must pass accountIds along with threadIds')
    }
    const tIds = threadIds || threads.map(t => t.id);
    const timerId = Utils.generateTempId()
    let accounts
    if (!threads) {
      accounts = accountIds
        .map(id => AccountStore.accountForId(id))
        .filter(Boolean)
    } else {
      accounts = AccountStore.accountsForItems(threads)
    }
    const firstProvider = accounts[0].provider
    const haveSameProvider = accounts
      .reduce((provider, acct) => (acct.provider === provider ? provider : false), firstProvider)
    const provider = haveSameProvider ? firstProvider : 'mixed'
    const timerData = {
      source,
      action,
      provider,
      targetCategory,
      threadIds: tIds,
    }
    this._timers.set(timerId, timerData)
    NylasEnv.timer.start(timerId)
  }

  _onArchiveThreads = ({threads, source} = {}) => {
    if (!threads) { return }
    if (threads.length === 0) { return }
    this._setNewTimer({threads, source, action: 'remove-threads-from-list', targetCategory: 'archive'})
    const tasks = TaskFactory.tasksForArchiving({threads, source})
    Actions.queueTasks(tasks)
  }

  _onTrashThreads = ({threads, source} = {}) => {
    if (!threads) { return }
    if (threads.length === 0) { return }
    this._setNewTimer({threads, source, action: 'remove-threads-from-list', targetCategory: 'trash'})
    const tasks = TaskFactory.tasksForMovingToTrash({threads, source})
    Actions.queueTasks(tasks)
  }

  _onMarkAsSpamThreads = ({threads, source} = {}) => {
    if (!threads) { return }
    if (threads.length === 0) { return }
    this._setNewTimer({threads, source, action: 'remove-threads-from-list', targetCategory: 'spam'})
    const tasks = TaskFactory.tasksForMarkingAsSpam({threads, source})
    Actions.queueTasks(tasks)
  }

  _onToggleStarredThreads = ({threads, source} = {}) => {
    if (!threads) { return }
    if (threads.length === 0) { return }
    const task = TaskFactory.taskForInvertingStarred({threads, source})
    Actions.queueTask(task)
  }

  _onToggleUnreadThreads = ({threads, canBeUndone, source} = {}) => {
    if (!threads) { return }
    if (threads.length === 0) { return }
    const task = TaskFactory.taskForInvertingUnread({threads, source, canBeUndone})
    Actions.queueTask(task)
  }

  _onSetUnreadThreads = ({threads, unread, canBeUndone, source} = {}) => {
    if (!threads) { return }
    if (threads.length === 0) { return }
    const task = TaskFactory.taskForSettingUnread({threads, unread, source, canBeUndone})
    Actions.queueTask(task)
  }

  _onRemoveThreadsFromView = ({threads, ruleset, source} = {}) => {
    if (!threads) { return }
    if (threads.length === 0) { return }
    const currentPerspective = FocusedPerspectiveStore.current()
    const tasks = currentPerspective.tasksForRemovingItems(threads, ruleset, source)

    // This action can encompass many different actions, e.g.:
    // - unstarring in starred view
    // - changing unread in unread view
    // - Moving to inbox from trash
    // - archiving a search result (which won't actually remove it from the thread-list)
    // For now, we are only interested in timing actions that remove threads
    // from the inbox
    if (currentPerspective.isInbox()) {
      // TODO figure out the `targetCategory`
      this._setNewTimer({threads, source, action: 'remove-threads-from-list'})
    }
    Actions.queueTasks(tasks)
  }

  _onMoveThreadsToPerspective = ({targetPerspective, threadIds, accountIds} = {}) => {
    if (!threadIds) { return }
    if (threadIds.length === 0) { return }
    const currentPerspective = FocusedPerspectiveStore.current()

    // For now, we are only interested in timing actions that remove threads
    // from the inbox
    const targetCategories = targetPerspective.categories()
    const targetCategoryIsFolder = (
      targetCategories && targetCategories.length > 0 &&
      targetCategories.every(c => c.object === 'folder')
    )
    const isRemovingFromInbox = currentPerspective.isInbox() && targetCategoryIsFolder
    if (isRemovingFromInbox) {
      const targetCategory = targetPerspective.isArchive() ? 'archive' : targetPerspective.categoriesSharedName();
      this._setNewTimer({
        threadIds,
        accountIds,
        targetCategory,
        source: "Dragged to Sidebar",
        action: 'remove-threads-from-list',
      })
    }
    targetPerspective.receiveThreads(threadIds)
  }

  _onApplyCategoryToThreads = ({threads, source, categoryToApply} = {}) => {
    if (!threads) { return }
    if (threads.length === 0) { return }
    const task = TaskFactory.taskForApplyingCategory({
      threads,
      source,
      category: categoryToApply,
    })
    Actions.queueTask(task)
  }

  _onRemoveCategoryFromThreads = ({threads, source, categoryToRemove} = {}) => {
    if (!threads) { return }
    if (threads.length === 0) { return }
    // For now, we are only interested in timing actions that remove threads
    // from the inbox
    if (categoryToRemove.isInbox()) {
      this._setNewTimer({
        source,
        threads,
        targetCategory: 'archive',
        action: 'remove-threads-from-list',
      })
    }
    const task = TaskFactory.taskForRemovingCategory({
      threads,
      source,
      category: categoryToRemove,
    })
    Actions.queueTask(task)
  }
}

export default new ThreadListActionsStore()
