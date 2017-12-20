/*jshint esversion: 6 */

// Experimental

var tensorflow = protobuf.roots.tf.tensorflow;

class TensorFlowModel {

    constructor(hostService) {
    }

    openBuffer(buffer, identifier) { 
        try {
            if (identifier == 'saved_model.pb') {
                this._model = tensorflow.SavedModel.decode(buffer);
                this._graphs = [];
                for (var i = 0; i < this._model.metaGraphs.length; i++) {
                    this._graphs.push(new TensorFlowGraph(this, this._model.metaGraphs[i], i));
                }
                this._format = 'TensorFlow Saved Model';
                if (this._model.savedModelSchemaVersion) {
                    this._format += ' v' + this._model.savedModelSchemaVersion.toString();
                }
            }
            else {
                var metaGraphDef = null;
                try {
                    var graphDef = tensorflow.GraphDef.decode(buffer);
                    metaGraphDef = new tensorflow.MetaGraphDef();
                    metaGraphDef.graphDef = graphDef;
                    metaGraphDef.anyInfo = identifier;
                    this._format = 'TensorFlow Graph';
                }
                catch (err) {
                }

                if (!metaGraphDef) {
                    metaGraphDef = tensorflow.MetaGraphDef.decode(buffer);
                    this._format = 'TensorFlow MetaGraph';
                }

                this._model = new tensorflow.SavedModel();
                this._model.metaGraphs.push(metaGraphDef);
                this._graphs = [ new TensorFlowGraph(this._model, metaGraphDef, 0) ];
            }

            this._activeGraph = (this._graphs.length > 0) ? this._graphs[0] : null;

            if (!TensorFlowModel.operatorMetadata) {
                TensorFlowModel.operatorMetadata = new TensorFlowOperatorMetadata(hostService);
            }
        }
        catch (err) {
            return err;
        }
        return null;
    }

    format() {
        var summary = { properties: [], graphs: [] };
        summary.properties.push({ name: 'Format', value: this._format });

        this.graphs.forEach((graph) => {
            summary.graphs.push({
                name: graph.name,
                version: graph.version,
                tags: graph.tags,
                inputs: graph.inputs,
                outputs: graph.outputs
            });
            // metaInfoDef.tensorflowGitVersion
            // TODO signature
        });
    
        return summary;
    }

    get graphs() {
        return this._graphs;    
    }

    get activeGraph() {
        return this._activeGraph;
    }

    updateActiveGraph(name) {
        this.graphs.forEach((graph) => {
            if (name == graph.name) {
                this._activeGraph = graph;
                return;
            }            
        });
    }
}

class TensorFlowGraph {

    constructor(model, graph, index) {
        this._model = model;
        this._graph = graph;
        this._name = this._graph.anyInfo ? this._graph.anyInfo.toString() : ('(' + index.toString() + ')');

        this._nodeMap = {};
        var nodes = this._graph.graphDef.node;
        nodes.forEach((node) => {
            this._nodeMap[node.name] = node;   
            node.output = [];         
        });
        nodes.forEach((node) => {
            for (var i = 0; i < node.input.length; i++)
            {
                var split = node.input[i].split(':', 1);
                if (split.length == 1) {
                    split.push('0');
                }
                // TODO
                if (split[0].startsWith('^')) {
                    split[0] = split[0].substring(1);
                }
                var outputName = split[0];
                var outputIndex = parseInt(split[1]);
                var outputNode = this._nodeMap[outputName];
                node.input[i] = outputName + ':' + outputIndex.toString();
                if (outputNode) {
                    for (var j = outputNode.output.length; j <= outputIndex; j++) {
                        outputNode.output.push('');
                    }
                    outputNode.output[outputIndex] = node.input[i];
                }
            }
        });
        this._nodeOutputCountMap = {};
        nodes.forEach((node) => {
            node.output.forEach((output) => {
                var count = this._nodeOutputCountMap[output];
                if (!count) {
                    count = 0;
                }
                this._nodeOutputCountMap[output] = count + 1;
            });
        });

        this._initializerMap = {};
        this._graph.graphDef.node.forEach((node) => {
            if (this.checkNode(node, this._nodeOutputCountMap, 'Const', 0, 1)) {
                var value = node.attr['value'];
                if (value && value.hasOwnProperty('tensor')) {
                    this._initializerMap[node.output[0]] = new TensorFlowTensor(value.tensor, node.output[0], node.name, 'Constant');
                }
            }
        });
        this._graph.graphDef.node.forEach((node) => {
            if (this.checkNode(node, this._nodeOutputCountMap, 'Identity', 1, 1)) {
                var tensor = this._initializerMap[node.input[0]];
                if (tensor) {
                    this._initializerMap[node.input[0]] = "-";
                    tensor._id = node.output[0]; // TODO update tensor id
                    tensor._title = 'Identity Constant';
                    this._initializerMap[node.output[0]] = tensor;
                }
            }
        });

        this._inputMap = {};
        this._graph.graphDef.node.forEach((node) => {
            if (this.checkNode(node, this._nodeOutputCountMap, 'Placeholder', 0, 1)) {
                var dtype = node.attr['dtype'];
                var shape = node.attr['shape'];
                if (dtype && dtype.type && shape && shape.shape) {
                    this._inputMap[node.output[0]] = {
                        id: node.output[0],
                        name: node.name,
                        type: TensorFlowTensor.formatDataType(dtype.type) + TensorFlowTensor.formatTensorShape(shape.shape)
                    };
                }
            }
        });
    }

    get model() {
        return this._model;
    }

    get name() {
        return this._name;
    }

    get version() {
        if (this._graph.metaInfoDef && this._graph.metaInfoDef.tensorflowVersion) {
            return 'TensorFlow ' + this._graph.metaInfoDef.tensorflowVersion;
        }
        return null;
    }

    get tags() {
        if (this._graph.metaInfoDef && this._graph.metaInfoDef.tags) {
            return this._graph.metaInfoDef.tags.join(', ');
        }
        return null;
    }

    get inputs() {
        var results = [];
        Object.keys(this._inputMap).forEach((key) => {
            results.push(this._inputMap[key]);
        });
        return results;
    }

    get outputs() {
        return [];
    }

    get initializers() {
        var results = [];
        Object.keys(this._initializerMap).forEach((key) => {
            var value = this._initializerMap[key];
            if (value != '-') {
                results.push(value);
            }
        });
        return results;
    }

    get nodes() {
        // graph.graphDef.node.forEach(function (node) {
        //     console.log(node.name + ' [' + (!node.input ? "" : node.input.map(s => s).join(',')) + ']');
        // });
        var results = [];
        this._graph.graphDef.node.forEach((node) => {
            var id = node.name + ':0';
            if (!this._initializerMap[id] && !this._inputMap[id] && node.op != 'NoOp') {
                results.push(new TensorFlowNode(this, node));
            }
        });
        return results;
    }

    get metadata() {
        if (!this._metadata) {
            this._metadata = new TensorFlowGraphOperatorMetadata(this._graph.metaInfoDef);
        }
        return this._metadata;
    }

    checkNode(node, map, operator, inputs, outputs) {
        if (node.op != operator) {
            return false;
        }
        if (outputs == 0 && node.output.length != 0) {
            return false;
        }
        if (inputs == 0 && node.input.length != 0) {
            return false;
        }
        if (outputs > 0 && node.output.length != 1 && map[node.output[0] != outputs]) {
            return false;
        }
        if (inputs > 0 && node.input.length != 1 && map[node.input[0] != inputs]) {
            return false;
        }
        return true;
    }
}

class TensorFlowNode {

    constructor(graph, node) {
        this._graph = graph;
        this._node = node;
    }

    get graph() {
        return this._graph;
    }

    get operator() {
        return this._node.op;
    }

    get name() {
        return this._node.name;
    }

    get description() {
        return null;
    }

    get primitive() {
        /*
        switch (this._node.op) {
            case 'Add': return '+';
            case 'Mul': return '*';
            case 'Sub': return '-';
            case 'Identity': return 'I';
        }
        */
        return null;
    }

    get constant() {
        return this._node.op == 'Const';
    }

    get documentation() {
        var graphMetadata = this._graph.metadata;
        if (graphMetadata) {
            return graphMetadata.getOperatorDocumentation(this.operator);       
        }
        return null;
    }

    get domain() {
        return null;
    }

    get inputs() {
        var graphMetadata = this._graph.metadata;
        var node = this._node;
        var results = [];
        if (node.input) {
            node.input.forEach((input, index) => {
                results.push({
                    'id': input, 
                    'name': graphMetadata ? graphMetadata.getInputName(node.op, index) : ('(' + index.toString() + ')'),
                    'type': ''
                });
            });
        }
        return results;
    }

    get outputs() {
        var graphMetadata = this._graph.metadata;
        var node = this._node;
        var results = [];
        if (node.output) {
            node.output.forEach((output, index) => {
                results.push({
                    'id': output, 
                    'name': graphMetadata ? graphMetadata.getOutputName(node.op, index) : ('(' + index.toString() + ')'),
                    'type': ''
                });
            });
        }
        return results;
    }

    get attributes() {
        var node = this._node;
        var result = [];
        if (node.attr) {
            Object.keys(node.attr).forEach((name) => {
                var hidden = (name == '_output_shapes'); //   || name == 'T');
                var value = node.attr[name];
                result.push(new TensorFlowAttribute(this, name, value, hidden));
            });
        }
        return result;
    }
}

class TensorFlowAttribute { 
    constructor(node, name, value, hidden) {
        this._node = node;
        this._name = name;
        this._value = value;
        if (hidden) {
            this._hidden = hidden;
        }
    }

    get name() {
        return this._name;
    }

    get type() {
        if (this._value.hasOwnProperty('tensor')) {
            return TensorFlowTensor.formatTensorType(this._value.tensor);
        }
        var graphMetadata = this._node.graph.metadata;
        if (graphMetadata) {
            return graphMetadata.getAttributeType(this._node.operator, this._name);
        }
        return '';
    }

    get value() {
        var item = TensorFlowAttribute.formatAttributeValue(this._value);
        if (Array.isArray(item)) {
            return item.join(', ');
        }
        return item;
    }

    static formatAttributeValue(value) {
        if (value.hasOwnProperty('type')) {
            return TensorFlowTensor.formatDataType(value.type);
        }
        else if (value.hasOwnProperty('i')) {
            return value.i.toString();
        }
        else if (value.hasOwnProperty('f')) {
            return value.f.toString();
        }
        else if (value.hasOwnProperty('b')) {
            return value.b.toString();
        }
        else if (value.hasOwnProperty('shape')) {
            return TensorFlowTensor.formatTensorShape(value.shape);;
        }
        else if (value.hasOwnProperty('s')) {
            if (value.s.filter(c => c <= 32 && c >= 128).length == 0) {
                return '"' + String.fromCharCode.apply(null, value.s) + '"';
            }
            return value.s.map(v => v.toString()).join(', ');           
        }
        else if (value.hasOwnProperty('tensor')) {
            return new TensorFlowTensor(value.tensor).value;
        }
        else if (value.hasOwnProperty('list')) {
            var list = value.list;
            if (list.s && list.s.length > 0) {
                if (list.s.length > 65536) {
                    return "Too large to render.";
                }
                return list.s.map((s) => {
                    if (s.filter(c => c <= 32 && c >= 128).length == 0) {
                        return '"' + String.fromCharCode.apply(null, s) + '"';
                    }
                    return s.map(v => v.toString()).join(', ');    
                });
            }
            else if (list.i && list.i.length > 0) {
                if (list.i.length > 65536) {
                    return "Too large to render.";
                }
                return list.i.map((v) => v.toString());
            }
            else if (list.f && list.f.length > 0) {
                if (list.f.length > 65536) {
                    return "Too large to render.";
                }
                return list.f.map((v) => v.toString());
            }
            else if (list.type && list.type.length > 0) {
                if (list.type.length > 65536) {
                    return "Too large to render.";
                }
                return list.type.map((type) => TensorFlowTensor.formatDataType(type));
            }
            else if (list.shape && list.shape.length > 0) {
                if (list.shape.length > 65536) {
                    return "Too large to render.";
                }
                return list.shape.map((shape) => TensorFlowTensor.formatTensorShape(shape));
            }
        }
        debugger;
        return '';        
    }

    get hidden() {
        return this._hidden ? this._hidden : false;
    }

    get tensor() {
        return this._value.hasOwnProperty('tensor');
    }
}

class TensorFlowTensor {

    constructor(tensor, id, name, title) {
        this._tensor = tensor;
        this._id = id;
        this._name = name;
        if (title) {
            this._title = title;
        }
    }

    get id() {
        return this._id;
    }

    get name() {
        return this._name;
    }

    get type() {
        return TensorFlowTensor.formatTensorType(this._tensor);
    }

    get title() {
        return this._title;
    }

    get value() {
        if (!this._tensor.dtype) {
            return 'Tensor has no data type.';
        }
        if (!this._tensor.tensorShape || !this._tensor.tensorShape.dim) {
            return 'Tensor has no dimensions.';
        }

        this._size = 1;
        this._tensor.tensorShape.dim.forEach((dim) => {
            this._size = this._size * (dim.size ? dim.size : 0);
        });

        switch (this._tensor.dtype) {
            case tensorflow.DataType.DT_FLOAT:
                if (this._tensor.tensorContent && this._tensor.tensorContent.length > 0) {
                    this._rawData = new DataView(this._tensor.tensorContent.buffer, this._tensor.tensorContent.byteOffset, this._tensor.tensorContent.byteLength)
                }
                else if (this._tensor.floatVal && this._tensor.floatVal.length == this._size) {
                    this._data = this._tensor.floatVal;
                }
                else {
                    return 'Tensor data is empty.';
                }
                break;
            case tensorflow.DataType.DT_INT32:
                if (this._tensor.tensorContent && this._tensor.tensorContent.length > 0) {
                    this._rawData = new DataView(this._tensor.tensorContent.buffer, this._tensor.tensorContent.byteOffset, this._tensor.tensorContent.byteLength)
                }
                else if (this._tensor.intVal && this._tensor.intVal.length == this._size) {
                    this._data = this._tensor.intVal;
                }
                else {
                    return 'Tensor data is empty.';
                }
                break;
            case tensorflow.DataType.DT_STRING:
                if (this._tensor.tensorContent && this._tensor.tensorContent.length > 0) {
                    return 'Tensor data type is not implemented.';
                }
                else if (this._tensor.stringVal && this._tensor.stringVal.length == this._size) {
                    this._data = this._tensor.stringVal;
                }
                else {
                    return 'Tensor data is empty.';
                }
                break;
            default:
                debugger;
                return 'Tensor data type is not implemented.';
        }

        this._index = 0;
        this._count = 0;
        this._utf8Decoder = window.TextDecoder ? new TextDecoder('utf-8') : null;
        var result = this.read(0);
        delete this._size;
        delete this._index;
        delete this._count;
        delete this._data;
        delete this._rawData;
        delete this._utf8Decoder;

        return JSON.stringify(result, null, 4);
    }

    read(dimension) {
        var results = [];
        var dimensions = this._tensor.tensorShape.dim;
        if (dimensions.length == 0 && this._data.length == 1) {
            return this.readDataValue();
        }
        var dim = dimensions[dimension];
        var size = dim.size;
        if (dimension == dimensions.length - 1) {
            for (var i = 0; i < size; i++) {
                if (this._count > 10000) {
                    results.push('...');
                    return results;
                }
                if (this._data) {
                    results.push(this.readDataValue());
                }
                else {
                    if (this._rawData) {
                        switch (this._tensor.dtype)
                        {
                            case tensorflow.DataType.DT_FLOAT:
                                results.push(this._rawData.getFloat32(this._index, true));
                                this._index += 4;
                                this._count++;
                                break;
                            case tensorflow.DataType.DT_INT32:
                                results.push(this._rawData.getInt32(this._index, true));
                                this._index += 4;
                                this._count++;
                                break;
                        }
                    }
                }
            }
        }
        else {
            for (var j = 0; j < size; j++) {
                if (this._count > 10000) {
                    results.push('...');
                    return results;
                }
                results.push(this.read(dimension + 1));
            }
        }
        return results;
    }

    readDataValue() {
        var value = this._data[this._index++];
        if (this._tensor.dtype == tensorflow.DataType.DT_STRING) {
            if (this._utf8Decoder) {
                value = this._utf8Decoder.decode(value);
            }
            else {
                value = String.fromCharCode.apply(null, textArray);
            }
        }
        return value;
    }

    static formatTensorType(tensor) {
        if (tensor.dtype) {
            var type = TensorFlowTensor.formatDataType(tensor.dtype);
            if (tensor.tensorShape) {
                type += TensorFlowTensor.formatTensorShape(tensor.tensorShape);
            }
            return type;
        }
        debugger;
        return '?';
    }

    static formatDataType(type) {
        if (!TensorFlowTensor.dataType)
        {
            TensorFlowTensor.dataType = {};
            Object.keys(tensorflow.DataType).forEach((key) => {
                var value = tensorflow.DataType[key];
                key = key.startsWith('DT_') ? key.substring(3) : key;
                TensorFlowTensor.dataType[value] = key.toLowerCase();
            });
        }
        var text = TensorFlowTensor.dataType[type];
        if (text) { 
            return text;
        }
        debugger;
        return '?';
    }

    static formatTensorShape(shape) {
        if (shape.dim) {
            if (shape.dim.length == 0) {
                return '';
            }
            if (shape.dim.length == 1 && !shape.dim[0].size) {
                return '[0]';
            }
            return '[' + shape.dim.map((dim) => dim.size ? dim.size.toString() : '?').join(',') + ']';
        }
        debugger;
        return '?';
    }
}

class TensorFlowOperatorMetadata {

    constructor(hostService) {
        this._map = {};
        hostService.request('/tf-operator.pb', (err, data) => {
            if (err != null) {
            }
            else {
                var operators = tensorflow.OpList.decode(data);
                if (operators.op) {
                    operators.op.forEach((opDef) => {
                        this._map[opDef.name] = opDef;
                    });
                }
            }
        });
    }

    getOpDef(operator) {
        return this._map[operator];
    }
}

class TensorFlowGraphOperatorMetadata {

    constructor(metaInfoDef) {
        this._map = {};
        if (metaInfoDef && metaInfoDef.strippedOpList && metaInfoDef.strippedOpList.op) {
            metaInfoDef.strippedOpList.op.forEach((opDef) => {
                this._map[opDef.name] = schema;
            });
        }
    }

    getOpDef(operator) {
        var schema = TensorFlowModel.operatorMetadata.getOpDef(operator);
        if (!schema) {
            schema = this._map[operator];
        }
        return schema;
    }

    getInputName(operator, index) {
        var opDef = this.getOpDef(operator);
        if (opDef) {
            var inputs = opDef.inputArg;
            if (inputs && index < inputs.length) {
                var input = inputs[index];
                if (input) {
                    var name = input.name;
                    if (name) {
                        return name;
                    }
                }
            }
        }
        return '(' + index.toString() + ')';
    }

    getOutputName(operator, index) {
        var opDef = this.getOpDef(operator);
        if (opDef) {
            var outputs = opDef.outputArg;
            if (outputs && index < outputs.length) {
                var output = outputs[index];
                if (output) {
                    var name = output.name;
                    if (name) {
                        return name;
                    }
                }
            }
        }
        return '(' + index.toString() + ')';
    }

    getAttributeType(operator, name) {
        var opDef = this.getOpDef(operator);
        if (opDef) {
            var attributeMap = opDef.attributeMap;
            if (!attributeMap) {
                attributeMap = {};
                if (opDef.attr) {
                    opDef.attr.forEach((attr) => {
                        attributeMap[attr.name] = attr;
                    });
                }
                opDef.attributeMap = attributeMap;
            }
            var attributeEntry = attributeMap[name];
            if (attributeEntry) { 
                return attributeEntry.type;
            }
        }        
        return '';
    }

    getOperatorDocumentation(operator) {
        var schema = {};
        var opDef = this.getOpDef(operator);
        if (opDef) {
            schema.name = operator;
            if (opDef.summary) {
                schema.summary = marked(opDef.summary);
            }
            if (opDef.description) {
                schema.description = marked(opDef.description);
            }
            if (opDef.inputArg) {
                schema.inputs = [];
                opDef.inputArg.forEach((inputArg) => {
                    var input = {};
                    input.name = inputArg.name;
                    if (inputArg.type) {
                        input.type = inputArg.type;
                    }
                    else if (inputArg.typeAttr) {
                        input.type = inputArg.typeAttr;
                    }
                    else if (inputArg.typeListAttr) {
                        input.type = inputArg.typeListAttr;
                    }
                    if (inputArg.description) {
                        input.description = marked(inputArg.description);
                    }
                    schema.inputs.push(input);
                });
            }
            if (opDef.outputArg) {
                schema.outputs = [];
                opDef.outputArg.forEach((outputArg) => {
                    var output = {};
                    output.name = outputArg.name;
                    if (outputArg.type) {
                        output.type = outputArg.type;
                    }
                    else if (outputArg.typeAttr) {
                        output.type = outputArg.typeAttr;
                    }
                    else if (outputArg.typeListAttr) {
                        output.type = outputArg.typeListAttr;
                    }
                    if (outputArg.description) {
                        output.description = marked(outputArg.description);
                    }
                    schema.outputs.push(output);
                });
            }
            if (opDef.attr) {
                schema.attributes = [];
                opDef.attr.forEach((attr) => {
                    var attribute = {};
                    attribute.name = attr.name;
                    if (attr.type) {
                        attribute.type = attr.type;
                    }
                    var description = attr.description;
                    if (attr.allowedValues) {
                        var allowedValues = TensorFlowAttribute.formatAttributeValue(attr.allowedValues);
                        allowedValues = Array.isArray(allowedValues) ? allowedValues : [ allowedValues ];
                        allowedValues = allowedValues.map((item) => '`' + item + '`').join(', ');
                        allowedValues = 'Must be one of the following: ' + allowedValues + '.';
                        description = description ? (allowedValues + ' ' + description) : allowedValues;
                    }
                    if (attr.defaultValue) {
                        var defaultValue = TensorFlowAttribute.formatAttributeValue(attr.defaultValue);
                        defaultValue = Array.isArray(defaultValue) ? defaultValue : [ defaultValue ];
                        defaultValue = defaultValue.map((item) => '`' + item + '`').join(', ');
                        defaultValue = 'Defaults to ' + defaultValue + '.';
                        description = description ? (defaultValue + ' ' + description) : defaultValue;
                    }
                    if (description) {
                        attribute.description = marked(description);
                    }
                    schema.attributes.push(attribute);
                });
            }
            var template = Handlebars.compile(operatorTemplate, 'utf-8');
            return template(schema);
        }
        return null;
    }
}