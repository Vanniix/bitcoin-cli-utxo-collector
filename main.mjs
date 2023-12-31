import { exec as execCallback} from 'child_process'
import { promisify } from 'util'
import promptGenerator from 'prompt-sync'
import { toXOnly } from "bitcoinjs-lib/src/psbt/bip371.js"
import * as bip39 from 'bip39'
import * as ecc from 'tiny-secp256k1'
import { BIP32Factory } from 'bip32'
import {
  Psbt,
  payments,
  networks,
  initEccLib,
  crypto
} from "bitcoinjs-lib"

initEccLib(ecc)
const prompt = promptGenerator()
const exec = promisify(execCallback)
const BIP_32 = BIP32Factory(ecc)

const DESTINATION_ADDRESS = 'bc1pt34pjkjc53hldy9uw8wtj40tcnvn9gq760pvdphkpa069dn7w0sqmhr79u'
const ADDRESSES_TO_SCAN = 10000
const MNEMONIC = ''
const FEES_SATPOINT = 'f3304ac7928cb86c7c08eb1791db3bb5f068cb70e27fadfc8518618e999fde23:945'
const FEE_RATE = 50

const NETWORK = networks.bitcoin
const DESC_REGEX = /^tr\(\[[^\/]*(\/\d\/\d+)\][^\)]*\)#.*$/
const PARENT_DESC_REGEX = /^(tr\([^\/]*)\/\d\/\*\)#.*$/

async function runBTCCommand(...args) {
  const response = await exec('bitcoin-cli ' + args.join(' '), {maxBuffer: 8 * 1024 * 1024})
  return JSON.parse(response.stdout)
}

async function getUtxos(...descriptors) {
  const scanOutset = (descriptor) => {
    return runBTCCommand('scantxoutset', 'start', `'${JSON.stringify([{
      "desc": descriptor,
      "range": ADDRESSES_TO_SCAN
    }])}'`)
  }
  
  const utxos = []
  let total = 0
  for (const descriptor of descriptors) {
    const outset = await scanOutset(descriptor)
    total += outset.total_amount
    utxos.push(...outset.unspents)
  }

  return [utxos, total]
}

function loadKey(hdNode, descriptor) {
  const chainCode = NETWORK == networks.bitcoin ? '0' : '1'
  const child = hdNode.derivePath(`m/86'/${chainCode}'/${descriptor}`)
  const pubKey = toXOnly(child.publicKey)
  return child.tweak(crypto.taggedHash('TapTweak', Buffer.concat([pubKey])))
}

function createTransaction(utxos, limit) {
  const seed = bip39.mnemonicToSeedSync(MNEMONIC)
  const wallet = BIP_32.fromSeed(seed)

  const [feesTxid, feesOutput] = FEES_SATPOINT.split(':')
  const feesUtxo = utxos.find(utxo => utxo.txid === feesTxid && utxo.vout === parseInt(feesOutput))

  if (feesUtxo == null) {
    console.log('Unable to find fees UTXO. Is the FEES_SATPOINT set correctly?')
    process.exit()
  }
  const keyMap = new Map()
  const paymentMap = new Map()

  utxos.forEach(utxo => {
    const match = utxo.desc.match(DESC_REGEX)
    if (match == null || match[1] == null) {
      console.log(`Failed to parse descriptor of ${utxo.desc}`)
      process.exit()
    }
    utxo.addressDescriptor = `0'${match[1]}`

    let key = keyMap.get(utxo.addressDescriptor)
    if (key == null) {
      key = loadKey(wallet, utxo.addressDescriptor)
      keyMap.set(utxo.addressDescriptor, key)
    }

    let payment = paymentMap.get(utxo.addressDescriptor)
    if (payment == null) {
      payment = payments.p2tr({ pubkey: toXOnly(key.publicKey), network: NETWORK })
      paymentMap.set(utxo.addressDescriptor, payment)
    }
  })

  let utxosToMove = utxos.filter(utxo => paymentMap.get(utxo.addressDescriptor).address !== DESTINATION_ADDRESS && utxo !== feesUtxo)
  if (limit != null && limit < utxosToMove.length) {
    utxosToMove = utxosToMove.slice(0, limit)
  }
  utxosToMove.push(feesUtxo)
  
  const inputs = utxosToMove.map(utxo => ({
    hash: utxo.txid,
    index: utxo.vout,
    sequence: 0xFFFFFFFD,
    tapInternalKey: toXOnly(keyMap.get(utxo.addressDescriptor).publicKey),
    witnessUtxo: { value: utxo.amount, script: paymentMap.get(utxo.addressDescriptor).output }
  }))
  
  const outputs = utxosToMove.map(utxo => ({
    address: DESTINATION_ADDRESS,
    value: utxo.amount
  }))

  const createRawTransaction = () => {
    const psbt = new Psbt({ network: NETWORK }).addInputs(inputs).addOutputs(outputs)
    for (let i = 0; i < inputs.length; i++) {
      psbt.signInput(i, keyMap.get(utxosToMove[i].addressDescriptor))
    }
    psbt.finalizeAllInputs()
    return psbt
  }

  const testTransaction = createRawTransaction()
  const fee = Math.round(testTransaction.extractTransaction().virtualSize() * FEE_RATE)
  outputs[outputs.length - 1].value -= fee
  if (outputs[outputs.length - 1].value < 0) {
    console.log(`Not enough funds. Transaction has fee of ${fee}, but you only have ${feesUtxo.amount} for fees`)
    process.exit()
  }
  return [createRawTransaction(), utxosToMove.length-1]
}

const unspent = await runBTCCommand('listunspent')
const blacklistedUnspent = unspent.find(utxo => utxo.address === DESTINATION_ADDRESS)

if (blacklistedUnspent == null) {
  console.log(`Unable to find address ${DESTINATION_ADDRESS}. Is the correct wallet loaded into bitcoin-cli?`)
  process.exit()
}

const exampleDesc = blacklistedUnspent.parent_descs[0]
const match = exampleDesc.match(PARENT_DESC_REGEX)
if (match == null || match[1] == null) {
  console.log(`Failed to parse parent descriptor of ${exampleDesc}`)
  process.exit()
}
const descPrefix = match[1]

const descriptor = (account) => `${descPrefix}/${account}/*)`
console.log("Scanning addresses for UTXO's. This may take a while...")
const [utxos, total] = await getUtxos(descriptor(0), descriptor(1))

utxos.forEach(utxo => { utxo.amount = Math.round(utxo.amount * 100000000)})

console.log(`${total}BTC found across ${utxos.length} UTXO's.`)
console.log("Please double check this agrees with Sparrow. If there is more in Sparrow there may be some UTXO's that haven't been detected.")
let response = prompt('Do you want to continue? (y/n)')
if (response.toLowerCase() !== 'y') {
  process.exit()
}

console.log("Preparing transaction UTXO's...")
const [testTx, amount] = createTransaction(utxos)
const size = testTx.extractTransaction().virtualSize()
const limit = Math.round((amount / (size / 100000)) * 0.95)
console.log(`There are a total of ${amount} UTXO's that need to be transferred`)
console.log(`Creating transaction to transfer ${Math.min(limit, amount)} of them...`)
const [psbt, _] = createTransaction(utxos, limit)
const tx = psbt.extractTransaction()

console.log(`Total UTXO's transferred: ${psbt.inputCount - 1}`)
console.log(`Feerate: ${psbt.getFeeRate()} sats/vbyte`)
console.log(`Total fees: ${psbt.getFee()} sats`)
console.log(`Total size: ${tx.virtualSize()} vBytes`)

response = prompt(`Transaction is ready to be broadcast. Do you want to broadcast it? (y/n)`)
if (response.toLowerCase() !== 'y') {
  process.exit()
}

const MEMPOOL_URL = NETWORK === networks.bitcoin ? 'https://mempool.space/api/tx' : 'https://mempool.space/testnet/api/tx'
const broadcastResponse = await fetch(MEMPOOL_URL, {
  method: 'POST',
  body: tx.toHex()
})

if (broadcastResponse.ok) {
  console.log('Successfully Broadcasted')
} else {
  console.log('Failed to broadcast')
}
console.log(await broadcastResponse.text())
console.log(`Your fees UTXO is now located at ${tx.getId()}:${psbt.txOutputs.length - 1}`)