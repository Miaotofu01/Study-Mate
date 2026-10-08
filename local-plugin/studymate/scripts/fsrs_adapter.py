"""The only dependency boundary for the official FSRS-6 scheduler."""
from datetime import datetime,timezone
from importlib.metadata import version
from fsrs import Card,Rating,Scheduler
from data_store import digest,utc
LIBRARY_VERSION='6.3.2'
def default_config():
    if version('fsrs')!=LIBRARY_VERSION: raise ValueError('Install fsrs=='+LIBRARY_VERSION)
    scheduler=Scheduler(desired_retention=.9,learning_steps=(),relearning_steps=(),maximum_interval=36500,enable_fuzzing=False)
    data={'schema_version':1,'algorithm':'FSRS-6','library_version':LIBRARY_VERSION,'effective_from':'1970-01-01T00:00:00+00:00','scheduler':scheduler.to_dict()}
    data['config_version']=digest(data)
    return data
def apply_review(card_data,card_id,rating,reviewed_at,config,duration_ms=None):
    if version('fsrs')!=config['library_version'] or config['library_version']!=LIBRARY_VERSION: raise ValueError('FSRS version mismatch')
    if type(rating)!=int or rating not in (1,2,3,4): raise ValueError('rating must be 1..4')
    scheduler=Scheduler.from_dict(config['scheduler'])
    card=Card.from_dict(card_data) if card_data else Card(card_id=card_id,due=utc(reviewed_at))
    updated,log=scheduler.review_card(card,Rating(rating),review_datetime=utc(reviewed_at),review_duration=duration_ms)
    return updated.to_dict(),log.to_dict()

