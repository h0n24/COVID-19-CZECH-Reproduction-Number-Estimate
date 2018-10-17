const Apify = require('apify')
const {google} = require('googleapis');
const csvParser =require('csvtojson')
const {apifyGoogleAuth} = require('apify-google-auth')

const {toRows, toObjects, append, replace,  countCells, trimSheetRequest} = require('./utils')

const MAX_CELLS = 2 * 1000 * 1000

Apify.main(async()=>{
    let input = await Apify.getValue('INPUT')
    console.log('input')
    console.dir(input)

    if(input.data && typeof input.data === 'object'){
        let parsedData
        try{
            parsedData = JSON.parse(input.data)
        } catch(e){
            throw ('Data from crawler webhook could not be parsed with error:',e)
        }
        input = {datasetOrExecutionId: input._id, ...parsedData}
    }

    let transformFunction = require('./transformFunctions').customTransform1
    //input.transformFunction = require('./transformFunctions').customTransform1
    if(input.transformFunction){
        try{
            transformFunction = eval(input.transformFunction)
        } catch(e){
            console.log('Evaluation of the tranform function failed with error:',e)
        }
        if(!transformFunction) throw new Error ('We were not able to parse transform function from input, therefore we cannot continue')
        if(input.mode === 'replace' && transformFunction.length !== 1) throw new Error ('If the mode is "replace", transform function has to take one argument!')
        if(input.mode === 'append' && transformFunction.length !== 2) throw new Error ('If the mode is "append", transform function has to take two arguments!')
    }

    const authOptions = {
        scope: "spreadsheets",
        tokensStore: input.tokensStore
    }
    const auth = await apifyGoogleAuth(authOptions)

    // loadData
    const defaultOptions = {
        format: 'csv',
        limit: input.limit,
        offset: input.offset,
    }

    let csv
    
    csv = await Apify.client.datasets.getItems({
        datasetId: input.datasetOrExecutionId,
        ...defaultOptions
    }).then(res=>res.items.toString()).catch(e=>console.log('could not load data from dataset, will try crawler execution'))
    
    if(!csv){
        csv = await Apify.client.crawlers.getExecutionResults({
            executionId: input.datasetOrExecutionId,
            simplified: 1,
            ...defaultOptions
        }).then(res=>res.items.toString()).catch(e=>console.log('could not load data from crawler'))
    }

    if(!csv) throw (`We didn't find any dataset or crawler execution with provided datasetOrExecutionId: ${input.datasetOrExecutionId}`)

    console.log('Data loaded from Apify storage')

    const newObjects = await csvParser().fromString(csv)

    if(newObjects.length === 0){
        console.log('We loaded 0 items from the dataset or crawler execution, finishing...')
    }

    const sheets = google.sheets({version: 'v4', auth});

    const {spreadsheetId, mode, filterByField, filterByEquality} = input

    const spreadsheetMetadata = await sheets.spreadsheets.get({spreadsheetId})
    const {title: firstSheetName, sheetId: firstSheetId} = spreadsheetMetadata.data.sheets[0].properties
    console.log('name of the first sheet', firstSheetName)
    console.log('id of the first sheet', firstSheetId)

    const range = input.range || firstSheetName
    
    console.log(`Spreadsheets setup:`)
    console.log('mode:',mode)
    console.log('spreadsheet id:',spreadsheetId)
    console.log('range:',range)
    console.log('filter by field:', filterByField)
    console.log('filter by equality:', filterByEquality)

    let rowsToInsert
    if(mode === 'replace'){
        const replacedObjects = replace({newObjects, filterByField, filterByEquality, transformFunction})
        rowsToInsert = toRows(replacedObjects)
    }
    if(mode === 'append'){
        rowsResponse = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range
        }).catch(e=>console.log('getting previous rows failed with error:',e.message))
        if(!rowsResponse || !rowsResponse.data) throw (`We couldn't get previous rows so we cannot compare!`)
        if(!rowsResponse.data.values){
            const replacedObjects = replace({newObjects, filterByField, filterByEquality, transformFunction})
            rowsToInsert = toRows(replacedObjects)
        } else {
            const oldObjects = toObjects(rowsResponse.data.values)
            const appendedObjects = append({oldObjects, newObjects, filterByField, filterByEquality, transformFunction})
            rowsToInsert = toRows(appendedObjects) 
        }  
    }

    // ensuring max cells limit
    const cellsToInsert = countCells(rowsToInsert)
    console.log(`Total rows: ${rowsToInsert.length}, total cells: ${cellsToInsert}`)
    if(cellsToInsert > MAX_CELLS) throw new Error (`You reached the max limit of ${MAX_CELLS} cells. Try inserting less rows.`)

    // trimming cells
    console.log('deleting unused cells')
    // trimming y axis
    await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        resource: trimSheetRequest(rowsToInsert.length, null, firstSheetId)
    }).catch(e => console.log('Deleting unused rows failed, maybe there were no usuned, Error:',e.message))

    // trimming x axis
    await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        resource: trimSheetRequest(null, rowsToInsert[0].length, firstSheetId)
    }).catch(e => console.log('Deleting unused columns failed, maybe there were no usuned, Error:',e.message))

    // clearing cells
    console.log('clearing cells')
    await sheets.spreadsheets.values.clear({
        spreadsheetId,
        range
    })

    console.log('inserting new cells')
    await sheets.spreadsheets.values.update({
        spreadsheetId,
        range,
        valueInputOption: 'RAW',
        resource:{values: rowsToInsert},
    })
    console.log('Items inserted...')
    console.log('Finishing actor...')
})

