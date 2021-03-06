const { shuffle } = require('shuffle-seed')
const { pollingAwait } = require('./utils')
const { generateReports } = require('./experiment-analysis')

class Experiment {
    constructor(options) {
        this.exportData = options.exportData
        this.trainModel = options.trainModel
        this.checkModelStatus = options.checkModelStatus
        this.predict = options.predict
        this.deleteModel = options.deleteModel

        this.config = {
            ...Experiment.getDefaultConfig(),
            ...options
        }

        this.log = this.config.VERBOSE ? console.log : () => { }
    }

    async run() {
        this.log('[MARCAO K-FOLD] STARTING EXPERIMENT')
        this.log('[MARCAO K-FOLD] EXPORTING DATA')
        let folds, trainModels
        if (!this.config.folds || !this.config.trainModels) {
            let data = await this.exportData()
            folds = this.partition(data)
            this.log('[MARCAO K-FOLD] TRAINING TEMPORARY MODELS')
            trainModels = await Promise.all(folds.map(fold => this.trainModel(fold.train)))
        } else {
            this.log('[MARCAO K-FOLD] TEMPORARY MODELS ALREADY CREATED')
            folds = this.config.folds
            trainModels = this.config.trainModels
        }
        let results = {}
        try {
            this.log('[MARCAO K-FOLD] WAITING FOR TEMPORARY MODELS TO TRAIN')
            await Promise.all(trainModels.map(model => this.waitUntilTrained(model)))
            this.log('[MARCAO K-FOLD] ALL TEMPORARY MODELS DONE TRAINING')
            if (this.config.trainOnly) throw new Error('[MARCAO K-FOLD] TRAIN ONLY RUN')
            let predictions = (await Promise.all(trainModels.map((model, i) => this.runTests(model, folds[i].test))))
                .reduce((predictions, foldPredictions) => [...predictions, ...foldPredictions], [])
            this.log('[MARCAO K-FOLD] GENERATING REPORTS')
            results = {
                predictions: predictions.sort((p1, p2) => JSON.stringify(p1) > JSON.stringify(p2)),
                reports: generateReports(predictions)
            }
        } catch (err) { this.log(err) }
        if (this.config.trainOnly) return { folds, trainModels }
        this.log('[MARCAO K-FOLD] DELETING TEMPORARY MODELS')
        await Promise.all(trainModels.map(model => this.deleteModel(model))).catch(err => { this.log(err) })
        this.log('[MARCAO K-FOLD] ALL DONE')
        return results
    }

    /**
     * Promise that resolves when a model is done training
     * @param {object} model 
     */
    waitUntilTrained(model) {
        this.log(`[MARCAO K-FOLD] [${model.id}] TRAINING`)
        return pollingAwait(() =>
            this.checkModelStatus(model)
                .then(done => {
                    this.log(`[MARCAO K-FOLD] [${model.id}] READY: ${done}`)
                    return done
                }),
        this.config.POLLING_INTERVAL,
        this.config.POLLING_TIMEOUT,
        )
    }

    /**
     * Splits a workspace into K folds for cross-validation
     * @param {array} data 
     * @returns array of folds
     */
    partition(data) {
        return shuffle(data, this.config.SEED)
            .reduce((exampleGroups, example, i) => exampleGroups
                .map((f, j) => i % this.config.NUM_FOLDS === j ? { train: f.train, test: f.test.concat(example) } : { train: f.train.concat(example), test: f.test }),
            Array(this.config.NUM_FOLDS).fill({ train: [], test: [] })
            )
    }

    /**
     * Runs a set of tests against a workspace
     * @param {object} model 
     * @param {Array} tests 
     */
    async runTests(model, tests) {
        this.log(`[MARCAO K-FOLD] [${model.id}] STARTING TESTS`)
        let allResponses = []
        for (let i = 0; i < tests.length; i += this.config.BATCH_SIZE) {
            this.log(`[MARCAO K-FOLD] [${model.id}] STARTING BATCH ${i} - ${i + this.config.BATCH_SIZE}`)
            let batch = tests.slice(i, i + this.config.BATCH_SIZE)
            let responses = await Promise.all(
                batch.map(example => this.predict(model, example.input)
                    .then(r => ({
                        input: example.input,
                        true_class: example.class,
                        output: r
                    }))
                )
            )
            allResponses = [...allResponses, ...responses]
            this.log(`[MARCAO K-FOLD] [${model.id}] FINISHED BATCH ${i} - ${i + this.config.BATCH_SIZE}`)
            await new Promise(r => setTimeout(() => r(), this.config.THROTTLE))
        }
        return allResponses
    }
}

Experiment.getDefaultConfig = () => ({
    VERBOSE: false,
    NUM_FOLDS: 3,
    BATCH_SIZE: 10,
    THROTTLE: 1000,
    POLLING_INTERVAL: 10000,
    POLLING_TIMEOUT: 600000,
    SEED: Math.random(),
})

module.exports = Experiment