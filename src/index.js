const Account = require('./billing-account')
const WebSocketChannel = require('./websocket-channel')

class BillingService {
    /**
     * @param {String} billingServerUrl - URL of the billing server
     * @param {String} serviceToken - Unique ID of the API service
     * @param {Object<String, Number>} pricing - Category/price mapping
     * @param {String[]} allowlist - List of always allowed request origins (own frontend origin)
     * @param {Number} syncInterval? - Synchronization checkpoints interval in seconds
     * @constructor
     */
    constructor({billingServerUrl, serviceToken, pricing, allowlist, syncInterval = 5}) {
        if (syncInterval < 5)
            throw new Error()
        this.syncInterval = syncInterval
        this.pricing = pricing
        this.allowlist = new Set(allowlist || [])
        this.pendingCharges = {}
        this.wsChannel = new WebSocketChannel({
            url: billingServerUrl,
            serviceToken,
            onStatusChange: this.onStatusChange.bind(this),
            onMessage: this.onMessage.bind(this)
        })
    }

    /**
     * Category/price mapping
     * @type {Object<String, Number>}
     * @readonly
     */
    pricing

    /**
     * @type {Number}
     * @readonly
     */
    syncInterval

    /**
     * @type {WebSocketChannel}
     * @private
     */
    wsChannel

    /**
     * @type {Set<String>}
     * @readonly
     */
    allowlist

    /**
     * @type {Object<String, BillingAccount>}
     * @private
     */
    accounts

    /**
     * Charges in format {accountId: {category:[chargesCounter, chargedCredits]}}
     * @type {Object<String, Object<String, Number[]>>}
     * @private
     */
    pendingCharges

    /**
     * @type {Number}
     * @private
     */
    syncTimerHandler

    /**
     * @type {Boolean}
     * @private
     */
    syncInProgress = false

    get isInitialized() {
        return this.accounts !== null
    }

    /**
     * Connect to billing server
     */
    connect() {
        if (this.wsChannel.status === 'connected')
            return
        this.wsChannel.connect()
        this.scheduleSync()
    }

    /**
     * Close connection and stop service
     */
    terminate() {
        clearTimeout(this.syncTimerHandler)
        this.syncTimerHandler = undefined
        this.wsChannel.close()
    }

    /**
     * Find account by unique ID
     * @param {String} id
     * @return {BillingAccount}
     */
    getAccount(id) {
        return this.accounts[id]
    }

    /**
     * Match account by request origin or authorization bearer API key
     * @param {{}} requestHeaders
     * @return {BillingAccount|Boolean}
     * @private
     */
    matchAccountFromRequestHeaders(requestHeaders) {
        let origin = requestHeaders.origin
        //check if the account origin belongs to our frontend
        if (origin && this.allowlist.has(origin))
            return true
        if (this.accounts) {
            if (origin) {
                //normalize
                origin = origin.toLowerCase().replace(/^https?:\/\//, '')
                //find account by origin
                const account = Object.values(this.accounts)
                    .find(a => a.origins?.some(ao =>
                        ao === origin || //direct domain match
                        ao.startsWith('*.') && origin.endsWith(ao.substring(1)) //wildcard match
                    ))
                if (account)
                    return account
            }
            //try to match account by provided API key
            const auth = requestHeaders.authorization
            if (auth) {
                const [type, apiKey] = auth.split(' ')
                //require only bearer authorization
                if (type === 'Bearer') {
                    return Object.values(this.accounts).find(a => a.apiKeys?.includes(apiKey)) || false
                }
            }
        }
        return false
    }

    /**
     * Charge credits from account
     * @param {String|{}} from - Account id
     * @param {String} category - API charge category
     * @return {Boolean} - True if credits have been charge and false otherwise
     */
    charge(from, category) {
        if (typeof from !== 'string') { //retrieve account based on headers
            const matched = this.matchAccountFromRequestHeaders(from)
            if (!matched.id)
                return matched //boolean result - return directly without charge
            from = matched.id
        }
        const account = this.accounts[from]
        if (!account)
            return false
        //resolve charge credits amount from pricing
        const chargedCredits = this.pricing[category]
        if (!account.tryCharge(chargedCredits))
            return false
        //increment charged counter and charged credits amount for a given account and category
        let accountCharges = this.pendingCharges[from]
        if (!accountCharges) {
            accountCharges = this.pendingCharges[from] = {}
        }
        let accountCategoryCharges = accountCharges[category]
        if (!accountCategoryCharges) {
            accountCategoryCharges = accountCharges[category] = [0, 0]
        }
        accountCategoryCharges[0]++
        accountCategoryCharges[1] += chargedCredits
        //credits charged successfully
        return true
    }

    /**
     * Schedule synchronization routine
     * @private
     */
    scheduleSync() {
        this.syncTimerHandler = setTimeout(() => this.syncCharges(), this.syncInterval * 1000)
    }

    /**
     * Send current local charges state changes to the billing server
     * @return {Promise}
     * @private
     */
    async syncCharges() {
        if (!this.syncTimerHandler)
            return
        if (this.wsChannel.status !== 'connected' || !Object.keys(this.pendingCharges).length || !this.accounts)
            return this.scheduleSync()
        if (!this.syncInProgress) {
            this.syncInProgress = true
            let data = this.pendingCharges
            let chargedBalances = {}
            try {
                //reset pending charges
                this.pendingCharges = {}
                //reset outstanding charged balances and temporarily store them until the request is executed
                for (let [id, account] of Object.entries(this.accounts)) {
                    chargedBalances[id] = account.chargedBalance
                    account.chargedBalance = 0
                }
                //send data to the server
                await this.wsChannel.notify({type: 'charge', data})
            } catch (e) {
                console.error('Failed to sync charges', e)
                console.error(e)
                //if request failed, we need to merge unsent changes with recently added charges
                for (let [unsentAccountId, unsentCharges] of Object.entries(data)) {
                    const newCharges = this.pendingCharges[unsentAccountId] || {}
                    for (let category of Object.keys(unsentCharges)) {
                        const nc = newCharges[category] || [0, 0]
                        newCharges[category] = unsentCharges[category].map((prevValue, i) => prevValue + nc[i])
                    }
                }
                //and restore charged balances
                for (let [id, charged] of Object.entries(chargedBalances)) {
                    const acc = this.accounts[id]
                    if (acc) {
                        acc.chargedBalance += charged
                    }
                }
            }
            this.syncInProgress = false
        }
        if (this.syncTimerHandler)
            this.scheduleSync()
    }

    /**
     * @param {Object<String, {}>} accountUpdates
     * @private
     */
    onAccountsUpdate(accountUpdates) {
        if (this.accounts == null)
            this.accounts = {}
        for (let accountProps of accountUpdates) {
            const accountId = accountProps.id
            let account = this.accounts[accountId]
            if (!account) {
                //create new Account wrapper
                account = this.accounts[accountId] = new Account(accountId)
                Object.assign(account, accountProps)
            }
            //update account properties
            account.update(accountProps)
        }
    }

    /**
     * @param {Object<String, Number>} balanceUpdates
     * @private
     */
    onBalancesUpdated(balanceUpdates) {
        for (let [id, balance] of Object.entries(balanceUpdates)) {
            const acc = this.accounts[id]
            if (acc) {
                acc.balance = balance
            }
        }
    }

    /**
     * @param {{}} message
     * @private
     */
    onMessage(message) {
        switch (message.type) {
            case 'accounts-update':
                this.onAccountsUpdate(message.data)
                break
            case 'balance-update':
                this.onBalancesUpdated(message.data)
                break
            default:
                console.log('Unknown message type: ' + message.type)
        }
    }

    /**
     * @param {WebSocketStatus} newStatus
     * @param {WebSocketStatus} prevStatus
     * @private
     */
    onStatusChange(newStatus, prevStatus) {
        console.log(`Billing connection status changed: ${prevStatus}=>${newStatus}`)
    }
}

module.exports = BillingService