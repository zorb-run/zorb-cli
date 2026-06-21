def action(inputs, context):
    context.log.info("python greeted " + inputs["name"])
    return {}
