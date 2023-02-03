class BillingAccount {
    /**
     * @param {String} id
     */
    constructor(id) {
        this.id = id
    }

    /**
     * Customer id
     * @type {String}
     * @readonly
     */
    id

    /**
     * Customer API keys
     * @type {String[]}
     * @readonly
     */
    apiKeys

    /**
     * Customer website origins
     * @type {String[]}
     */
    origins

    /**
     * Current account credits balance
     * @type {Number}
     */
    balance = 0

    /**
     * Amount of credits that have been charged from this account but not yet synced with the billing server
     * @type {Number}
     */
    chargedBalance = 0

    /**
     * Available number of credits
     * @return {Number}
     */
    get currentBalance() {
        return this.balance - this.chargedBalance
    }

    /**
     * Charge credits from the account balance
     * @param {Number} amount - Number of credits to charge
     * @return {Boolean} - Returns false if balance is not sufficient
     */
    tryCharge(amount) {
        if (this.currentBalance < amount)
            return false
        this.chargedBalance += amount
        return true
    }

    /**
     * Update credits and other account properties with value received from the server
     */
    update(accountProps) {
        Object.assign(this, accountProps)
    }
}

module.exports = BillingAccount