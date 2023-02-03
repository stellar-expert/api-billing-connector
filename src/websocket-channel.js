const WebSocket = require('ws')

/**
 * Billing WebSocket channel handler.
 */
class WebSocketChannel {
    constructor({url, serviceToken, onMessage, onStatusChange}) {
        if (!url)
            throw new Error('url is required')
        if (!serviceToken)
            throw new Error('serviceToken is required')
        this.url = url
        this.serviceToken = serviceToken
        this.onMessageHandler = onMessage
        this.onStatusChangeHandler = onStatusChange
        this.status = 'disconnected'
    }

    /**
     * Try to automatically reconnect to the server on close
     * @type {Boolean}
     * @readonly
     */
    autoReconnect

    /**
     * Current connection status
     * @type {WebSocketStatus}
     */
    status

    /**
     * @readonly
     */
    onMessageHandler

    /**
     * @type {StatusChangeHandler}
     * @readonly
     */
    onStatusChangeHandler

    /**
     * @type {WebSocket}
     * @readonly
     */
    ws

    connect() {
        this.autoReconnect = true
        this.ws = new WebSocket(this.url, [], {
            skipUTF8Validation: true,
            pingTimeout: 10000,
            headers: {
                Authorization: `Bearer ${this.serviceToken}`
            }
        })
        this.ws
            .on('open', this.onOpen.bind(this))
            .on('close', this.onClose.bind(this))
            .on('error', this.onError.bind(this))
            .on('message', this.onMessage.bind(this))
    }

    /**
     * Send message to the billing server
     * @param {{}} message
     * @return {Promise}
     */
    async notify(message) {
        this.ws.send(JSON.stringify(message))
    }

    /**
     * Close connection
     */
    close() {
        this.autoReconnect = false
        this.ws?.close()
    }

    /**
     * @private
     */
    onOpen() {
        if (this.ws?.readyState !== WebSocket.OPEN)
            throw new Error('Invalid websocket status: ' + this.ws?.readyState)
    }

    /**
     * @param {WebSocketStatus} newStatus
     * @private
     */
    changeStatus(newStatus) {
        const prevStatus = this.status
        if (prevStatus === newStatus)
            return
        this.status = newStatus
        this.onStatusChangeHandler?.(newStatus, prevStatus)
    }

    /**
     * @param {Buffer} message
     * @param {Boolean} isBinary
     * @return {Promise<void>}
     * @private
     */
    async onMessage(message, isBinary) {
        this.changeStatus('connected')
        try {
            if (isBinary)
                throw new TypeError('Unsupported binary WebSocket message format')
            const parsedMessage = JSON.parse(message.toString())
            this.onMessageHandler?.(parsedMessage)
        } catch (e) {
            console.error(e)
        }
    }

    /**
     * @private
     */
    onClose(errorCode) {
        if (this.ws) {
            this.ws.terminate()
        }
        this.ws = null
        if (errorCode === 1008) {
            console.error('Billing service token rejected by the server')
            this.autoReconnect = false
        }
        this.changeStatus('disconnected')
        clearInterval(this.pingWorker)
        this.pingWorker = null
        if (this.autoReconnect) {
            setTimeout(() => this.connect(), 2000)
        }
    }

    /**
     * @param {Error} error
     * @private
     */
    onError(error) {
        this.changeStatus('disconnected')
        this.close()
        setTimeout(() => this.connect(), 2000)
        //console.error('error', error)
    }
}

module.exports = WebSocketChannel

/**
 * @typedef {'disconnected'|'connected'} WebSocketStatus
 */

/**
 * @callback StatusChangeHandler
 * @param {string} newStatus
 * @param {string} prevStatus
 */